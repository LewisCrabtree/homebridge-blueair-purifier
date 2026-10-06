import EventEmitter from 'events';
import { randomUUID } from 'crypto';
import { connect, MqttClient, IClientOptions } from 'mqtt';
import { BlueAirDeviceSensorData, BlueAirDeviceSensorDataMap, BlueAirDeviceState, MqttCredentials } from './BlueAirAwsApi';

type Connector = (url: string, options: IClientOptions) => MqttClient;

/** One account connection, one reconnect owner. Never exposes auth headers in diagnostics. */
export class BlueAirMqtt extends EventEmitter {
  private client?: MqttClient;
  private stopped = true;
  private generation = 0;
  private connecting = false;
  private connected = false;
  private failures = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private renewTimers = new Map<string, NodeJS.Timeout>();
  private lastSensors = new Map<string, number>();
  private versions = new Map<string, number>();
  private eventTimes = new Map<string, number>();

  constructor(
    private readonly credentials: () => Promise<MqttCredentials | undefined>,
    private readonly devices: Map<string, number>,
    private readonly connector: Connector = connect,
  ) {
    super();
  }

  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    void this.open();
  }

  stop() {
    this.stopped = true;
    this.generation++;
    this.connecting = false;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.clearSessionTimers();
    const client = this.client;
    this.client = undefined;
    client?.end(true);
  }

  isHealthy(now = Date.now()) {
    return this.connected && [...this.devices.keys()].every((id) => now - (this.lastSensors.get(id) ?? 0) < 45000);
  }

  diagnostics() {
    return {
      connected: this.connected,
      healthy: this.isHealthy(),
      reconnectFailures: this.failures,
      lastSensorAt: Object.fromEntries(this.lastSensors),
    };
  }

  private clearSessionTimers() {
    clearTimeout(this.refreshTimer);
    for (const timer of this.renewTimers.values()) {
      clearTimeout(timer);
    }
    this.renewTimers.clear();
  }

  private async open() {
    if (this.stopped || this.connecting || this.client) {
      return;
    }
    this.connecting = true;
    const generation = ++this.generation;
    try {
      const auth = await this.credentials();
      if (this.stopped || generation !== this.generation) {
        return;
      }
      if (!auth) {
        throw new Error('Missing MQTT credentials');
      }
      const client = this.connector(`wss://${auth.host}/mqtt`, {
        protocolVersion: 4,
        clientId: randomUUID(),
        clean: true,
        keepalive: 60,
        connectTimeout: 15000,
        reconnectPeriod: 0,
        resubscribe: false,
        wsOptions: { headers: auth.headers, rejectUnauthorized: true },
      });
      this.client = client;
      const current = () => !this.stopped && generation === this.generation && this.client === client;
      client.on('error', () => {
        if (current()) {
          this.fail(generation);
        }
      });
      client.on('close', () => {
        if (current()) {
          this.fail(generation);
        }
      });
      client.on('connect', () => {
        if (!current()) {
          return;
        }
        this.connected = true;
        this.failures = 0;
        this.lastSensors.clear();
        this.emit('health', true);
        for (const id of this.devices.keys()) {
          this.subscribe(client, generation, `$aws/things/${id}/shadow/update/documents`);
          this.renew(id, client, generation);
        }
        this.subscribe(client, generation, `c/${auth.userId}/s/event`);
        if (current()) {
          const remaining = auth.expiresAt - Date.now();
          this.refreshTimer = setTimeout(() => this.fail(generation), Math.max(1000, remaining - Math.min(240000, remaining * 0.2)));
        }
      });
      client.on('message', (topic, payload, packet) => {
        if (current() && !packet.retain) {
          this.receive(topic, payload);
        }
      });
    } catch {
      if (!this.stopped && generation === this.generation) {
        this.fail(generation);
      }
    } finally {
      if (generation === this.generation) {
        this.connecting = false;
      }
    }
  }

  private fail(generation: number) {
    if (this.stopped || generation !== this.generation) {
      return;
    }
    this.generation++;
    this.connecting = false;
    this.connected = false;
    this.clearSessionTimers();
    const client = this.client;
    this.client = undefined;
    client?.end(true);
    this.emit('health', false);
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(300000, 5000 * 2 ** Math.min(this.failures++, 6));
    this.reconnectTimer = setTimeout(() => void this.open(), delay + Math.random() * delay * 0.2);
  }

  private subscribe(client: MqttClient, generation: number, topic: string) {
    client.subscribe(topic, { qos: 0 }, (error, granted) => {
      if (error || granted?.some((item) => item.qos === 128)) {
        this.fail(generation);
      }
    });
  }

  private renew(id: string, client: MqttClient, generation: number) {
    if (this.stopped || generation !== this.generation) {
      return;
    }
    clearTimeout(this.renewTimers.get(id));
    this.subscribe(client, generation, `d/${id}/s/5s`);
    if (this.stopped || generation !== this.generation) {
      return;
    }
    const ttl = this.devices.get(id) ?? 1200;
    this.renewTimers.set(
      id,
      setTimeout(() => this.renew(id, client, generation), Math.max(1000, ttl * 750)),
    );
  }

  private receive(topic: string, payload: Buffer) {
    if (payload.length > 65536) {
      return;
    }
    try {
      const data = JSON.parse(payload.toString());
      const now = Date.now();
      const sensorId = /^d\/([^/]+)\/s\/5s$/.exec(topic)?.[1];
      if (sensorId && this.devices.has(sensorId) && Array.isArray(data)) {
        const sensors: BlueAirDeviceSensorData = {};
        for (const row of data) {
          const key = row && BlueAirDeviceSensorDataMap[row.n];
          if (key && typeof row.v === 'number' && Number.isFinite(row.v) && row.v >= 0) {
            sensors[key] = row.v;
          }
        }
        if (Object.keys(sensors).some((key) => ['pm1', 'pm2_5', 'pm10', 'voc'].includes(key))) {
          this.lastSensors.set(sensorId, now);
          this.emit('sensors', sensorId, sensors, now);
        }
        return;
      }
      const stateId = /^\$aws\/things\/([^/]+)\/shadow\/update\/documents$/.exec(topic)?.[1];
      if (stateId && this.devices.has(stateId)) {
        const version = data.current?.version ?? data.version;
        const timestamp = data.current?.timestamp ?? data.timestamp;
        const state = data.current?.state?.reported;
        if (!state || !Number.isFinite(version) || version <= (this.versions.get(stateId) ?? -1)) {
          return;
        }
        const validated: BlueAirDeviceState = {};
        for (const [key, value] of Object.entries(state)) {
          if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') {
            validated[key] = value;
          }
        }
        this.versions.set(stateId, version);
        const at = Number.isFinite(timestamp) && timestamp > 0 ? Math.min(now, timestamp * 1000) : now;
        this.emit('state', stateId, validated, at);
        return;
      }
      if (topic.endsWith('/s/event') && this.devices.has(data.o) && ['Connected', 'NotConnected'].includes(data.et)) {
        const at = Number(data.ts) * 1000;
        if (!Number.isFinite(at) || at <= (this.eventTimes.get(data.o) ?? 0)) {
          return;
        }
        this.eventTimes.set(data.o, at);
        this.emit('online', data.o, data.et === 'Connected');
        if (data.et === 'Connected' && this.client) {
          this.renew(data.o, this.client, this.generation);
        } else {
          this.lastSensors.delete(data.o);
        }
      }
    } catch {
      // Malformed or unknown messages are ignored; never log potentially sensitive payloads.
    }
  }
}
