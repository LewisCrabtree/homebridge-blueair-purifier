import EventEmitter from 'events';
import { BlueAirDeviceSensorData, BlueAirDeviceState, BlueAirDeviceStatus, FullBlueAirDeviceState } from '../api/BlueAirAwsApi';
import { BlueAirDeviceType, getDeviceType } from './BlueAirDeviceType';
import { Mutex } from 'async-mutex';

type AQILevels = {
  AQI_LO: number[];
  AQI_HI: number[];
  CONC_LO: number[];
  CONC_HI: number[];
};

// https://forum.airnowtech.org/t/the-aqi-equation-2024-valid-beginning-may-6th-2024
const AQI: { [key: string]: AQILevels } = {
  PM2_5: {
    AQI_LO: [0, 51, 101, 151, 201, 301],
    AQI_HI: [50, 100, 150, 200, 300, 500],
    CONC_LO: [0.0, 9.1, 35.5, 55.5, 125.5, 225.5],
    CONC_HI: [9.0, 35.4, 55.4, 125.4, 225.4, 325.4],
  },
  PM10: {
    AQI_LO: [0, 51, 101, 151, 201, 301],
    AQI_HI: [50, 100, 150, 200, 300, 500],
    CONC_LO: [0, 55, 155, 255, 355, 425],
    CONC_HI: [54, 154, 254, 354, 424, 604],
  },
  VOC: {
    AQI_LO: [0, 51, 101, 151, 201, 301],
    AQI_HI: [50, 100, 150, 200, 300, 500],
    CONC_LO: [0, 221, 661, 1431, 2201, 3301],
    CONC_HI: [220, 660, 1430, 2200, 3300, 5500],
  },
};

type BlueAirSensorDataWithAqi = BlueAirDeviceSensorData & { aqi?: number };

export type DeviceWriter = (attribute: string, value: number | boolean) => Promise<void>;

export class BlueAirDevice extends EventEmitter {
  public state: BlueAirDeviceState;
  public sensorData: BlueAirSensorDataWithAqi;
  public readonly id: string;
  public readonly name: string;
  public readonly sku: string;
  public readonly deviceType: BlueAirDeviceType;
  public readonly supportedSensors: Set<string>;
  public readonly hardware?: string;
  private readonly writeMutex = new Mutex();
  private lastBrightness: number;
  private sensorTimes = new Map<string, number>();
  private sensorSources = new Map<string, string>();
  private pushStateTimes = new Map<string, number>();
  private pendingReports = new Map<string, { value: number | boolean; requestedAt: number; timer: NodeJS.Timeout }>();
  private reportedStates = new Map<string, { value: unknown; at: number; receivedAt: number }>();
  private reportTrackingStopped = false;

  constructor(
    device: BlueAirDeviceStatus,
    private readonly writer?: DeviceWriter,
    private readonly trackReports = false,
  ) {
    super();
    this.id = device.id;
    this.name = device.name;
    this.sku = device.sku;
    this.hardware = device.hardware;
    this.deviceType = getDeviceType(device.sku);
    this.supportedSensors = new Set(device.supportedSensors ?? Object.keys(device.sensorData));
    this.state = { ...device.state };
    this.sensorData = { ...device.sensorData };
    for (const key of Object.keys(device.sensorData)) {
      this.sensorTimes.set(key, device.sensorTimestamps?.[key] ?? Date.now());
      this.sensorSources.set(key, device.historicalSensors?.includes(key) ? 'history' : 'rest');
      if (Date.now() - this.sensorTimes.get(key)! >= 600000) {
        delete this.sensorData[key];
      }
    }
    this.sensorData.aqi = this.calculateAqi();
    this.lastBrightness = this.state.brightness || 100;
    this.on('update', this.updateState.bind(this));
  }

  public async setState(attribute: string, value: number | boolean): Promise<void> {
    await this.writeMutex.runExclusive(async () => {
      if (!(attribute in this.state)) {
        throw new Error(`Unsupported control: ${attribute}`);
      }
      if (this.state[attribute] === value) {
        return;
      }
      if (!this.writer) {
        throw new Error('No cloud writer configured');
      }
      const requestedAt = Date.now();
      await this.writer(attribute, value);
      if (this.trackReports && !this.reportTrackingStopped) {
        clearTimeout(this.pendingReports.get(attribute)?.timer);
        const timer = setTimeout(() => {
          this.pendingReports.delete(attribute);
          this.emit('commandConfirmation', attribute, 'unconfirmed');
        }, 30000);
        timer.unref();
        this.pendingReports.set(attribute, { value, requestedAt, timer });
        const report = this.reportedStates.get(attribute);
        if (report) {
          this.confirmReport(attribute, report.value, report.at, report.receivedAt);
        }
      }
      // A cloud acknowledgement is not physical-device confirmation. Polling reconciles the snapshot.
      this.state = { ...this.state, [attribute]: value };
      this.emit('stateUpdated', { [attribute]: value });
    });
  }

  public async setLedOn(value: boolean) {
    if (!value && (this.state.brightness || 0) > 0) {
      this.lastBrightness = this.state.brightness!;
    }
    await this.setState('brightness', value ? this.lastBrightness : 0);
  }

  public updateState(newState: BlueAirDeviceStatus, source = 'rest', receivedAt = Date.now()) {
    const changes: Partial<FullBlueAirDeviceState> = {};
    const state: BlueAirDeviceState = {};
    for (const [key, value] of Object.entries(newState.state)) {
      const at = newState.stateTimestamps?.[key] ?? receivedAt;
      if (source === 'rest' && at < (this.pushStateTimes.get(key) ?? 0)) {
        continue;
      }
      if (source === 'mqtt') {
        if (at < (this.pushStateTimes.get(key) ?? 0)) {
          continue;
        }
        this.pushStateTimes.set(key, at);
      }
      state[key] = value;
      this.reportedStates.set(key, { value, at, receivedAt });
      this.confirmReport(key, value, at, receivedAt);
      if (this.state[key] !== value) {
        changes[key] = value;
      }
    }
    const sensors: BlueAirSensorDataWithAqi = source === 'mqtt' ? { ...this.sensorData } : {};
    for (const [key, value] of Object.entries(newState.sensorData)) {
      const at = Math.min(receivedAt, newState.sensorTimestamps?.[key] ?? receivedAt);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        continue;
      }
      if (at < (this.sensorTimes.get(key) ?? 0)) {
        sensors[key] = this.sensorData[key];
        continue;
      }
      sensors[key] = value;
      this.sensorTimes.set(key, at);
      this.sensorSources.set(key, source === 'mqtt' ? 'mqtt' : newState.historicalSensors?.includes(key) ? 'history' : 'rest');
    }
    // Sparse REST snapshots must not erase fresh push readings. Other missing readings remain unknown.
    for (const [key, at] of this.sensorTimes) {
      if (source === 'rest' && this.sensorSources.get(key) === 'mqtt' && receivedAt - at < 600000 && sensors[key] === undefined) {
        sensors[key] = this.sensorData[key];
      }
      if (receivedAt - at >= 600000) {
        delete sensors[key];
      }
    }
    sensors.aqi = this.calculateAqi(sensors);
    for (const key of new Set([...Object.keys(this.sensorData), ...Object.keys(sensors)])) {
      if (this.sensorData[key] !== sensors[key]) {
        changes[key] = sensors[key];
      }
    }
    this.state = { ...this.state, ...state };
    this.sensorData = sensors;
    if (Object.keys(changes).length > 0) {
      this.emit('stateUpdated', changes);
    }
  }

  public applyPush(state: BlueAirDeviceState, sensorData: BlueAirDeviceSensorData, at: number) {
    this.updateState({ id: this.id, name: this.name, sku: this.sku, state, sensorData }, 'mqtt', at);
  }

  public expireSensors(now = Date.now()) {
    this.applyPush({}, {}, now);
  }

  public sensorDiagnostics() {
    return Object.fromEntries(
      [...this.sensorTimes].map(([key, at]) => [
        key,
        { updatedAt: at, source: this.sensorSources.get(key), available: this.sensorData[key] !== undefined },
      ]),
    );
  }

  private confirmReport(attribute: string, value: unknown, at: number, receivedAt: number) {
    const pending = this.pendingReports.get(attribute);
    if (pending && value === pending.value && receivedAt >= pending.requestedAt && at >= pending.requestedAt - 1000) {
      clearTimeout(pending.timer);
      this.pendingReports.delete(attribute);
      this.emit('commandConfirmation', attribute, 'reported');
    }
  }

  public stop() {
    this.reportTrackingStopped = true;
    for (const pending of this.pendingReports.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingReports.clear();
  }

  private calculateAqi(sensors = this.sensorData): number | undefined {
    const results: number[] = [];
    for (const [key, type] of [
      ['pm2_5', 'PM2_5'],
      ['pm10', 'PM10'],
      ['voc', 'VOC'],
    ]) {
      const value = sensors[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        const concentration = type === 'PM2_5' ? Math.floor(value * 10) / 10 : Math.floor(value);
        results.push(this.calculateAqiForSensor(concentration, type));
      }
    }
    return results.length ? Math.max(...results) : undefined;
  }

  private calculateAqiForSensor(value: number, sensor: string): number {
    const levels = AQI[sensor];
    const last = levels.AQI_LO.length - 1;
    if (value > levels.CONC_HI[last]) {
      return levels.AQI_HI[last];
    }
    for (let i = 0; i <= last; i++) {
      if (value <= levels.CONC_HI[i]) {
        return Math.round(
          ((levels.AQI_HI[i] - levels.AQI_LO[i]) / (levels.CONC_HI[i] - levels.CONC_LO[i])) *
            (Math.max(value, levels.CONC_LO[i]) - levels.CONC_LO[i]) +
            levels.AQI_LO[i],
        );
      }
    }
    return 0;
  }
}
