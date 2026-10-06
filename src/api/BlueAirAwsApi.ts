import { Logger } from 'homebridge';
import { Region } from '../platformUtils';
import GigyaApi from './GigyaApi';
import { BLUEAIR_API_TIMEOUT, BlueAirDeviceStatusResponse, BlueAirTelemetryResponse, LOGIN_EXPIRATION, getAwsConfig } from './Consts';
import { Mutex } from 'async-mutex';
import { RequestPolicy, CloudHttpError, CloudCooldownError } from './RequestPolicy';

type BlueAirDeviceDiscovery = {
  mac: string;
  'mcu-firmware': string;
  name: string;
  type: string;
  'user-type': string;
  uuid: string;
  'wifi-firmware': string;
};

export type FullBlueAirDeviceState = BlueAirDeviceState & BlueAirDeviceSensorData;

export type BlueAirDeviceState = {
  cfv?: string;
  germshield?: boolean;
  gsnm?: boolean;
  standby?: boolean;
  fanspeed?: number;
  childlock?: boolean;
  nightmode?: boolean;
  mfv?: string;
  automode?: boolean;
  apsubmode?: number;
  ofv?: string;
  brightness?: number;
  safetyswitch?: boolean;
  filterusage?: number;
  disinfection?: boolean;
  disinftime?: number;
  [key: string]: string | number | boolean | undefined;
};

export type BlueAirDeviceSensorData = {
  fanspeed?: number;
  hcho?: number;
  humidity?: number;
  pm1?: number;
  pm10?: number;
  pm2_5?: number;
  temperature?: number;
  voc?: number;
  [key: string]: string | number | boolean | undefined;
};

export type BlueAirDeviceStatus = {
  id: string;
  name: string;
  sku: string;
  supportedSensors?: string[];
  hardware?: string;
  sensorTimestamps?: Record<string, number>;
  stateTimestamps?: Record<string, number>;
  historicalSensors?: string[];
  sensorStreamTtl?: number;
  state: BlueAirDeviceState;
  sensorData: BlueAirDeviceSensorData;
};

export type MqttCredentials = { host: string; userId: string; headers: Record<string, string>; expiresAt: number };

type BlueAirSetStateBody = {
  n: string;
  v?: number;
  vb?: boolean;
};

export const BlueAirDeviceSensorDataMap: Record<string, keyof BlueAirDeviceSensorData> = {
  fsp0: 'fanspeed',
  hcho: 'hcho',
  h: 'humidity',
  pm1: 'pm1',
  pm10: 'pm10',
  pm2_5: 'pm2_5',
  t: 'temperature',
  tVOC: 'voc',
};

export default class BlueAirAwsApi {
  private readonly gigyaApi: GigyaApi;
  private readonly policy = new RequestPolicy();
  private loginPromise?: Promise<void>;
  private telemetryCache = new Map<string, { time: number; data: BlueAirDeviceSensorData }>();
  private telemetryTimes = new Map<string, Record<string, number>>();
  private mqttCredentials?: MqttCredentials;

  private last_login: number;

  private mutex: Mutex;

  private accessToken: string;
  private idToken: string;
  private userId: string;
  private blueAirApiUrl: string;

  constructor(
    username: string,
    password: string,
    region: Region,
    private readonly logger: Logger,
    private readonly cloudRegion: Region = region,
  ) {
    const config = getAwsConfig(cloudRegion);
    this.blueAirApiUrl = `https://${config.restApiId}.execute-api.${config.awsRegion}.amazonaws.com/prod/c`;

    this.mutex = new Mutex();

    this.logger.debug(`Blueair auth region: ${region}; control region: ${cloudRegion}`);

    this.gigyaApi = new GigyaApi(username, password, region, logger);

    this.last_login = 0;
    this.accessToken = '';
    this.idToken = '';
    this.userId = '';
  }

  get cooldownMs(): number {
    return this.policy.remainingMs;
  }

  async getMqttCredentials(): Promise<MqttCredentials | undefined> {
    if (!this.mqttCredentials || this.mqttCredentials.expiresAt - Date.now() < 300000) {
      await this.login();
    }
    return this.mqttCredentials;
  }

  async login(): Promise<void> {
    this.policy.assertReady();
    if (!this.loginPromise) {
      this.loginPromise = this.performLogin().finally(() => {
        this.loginPromise = undefined;
      });
    }
    return this.loginPromise;
  }

  private async performLogin(): Promise<void> {
    this.logger.debug('Logging in...');

    try {
      const { token, secret } = await this.gigyaApi.getGigyaSession();
      const { jwt } = await this.gigyaApi.getGigyaJWT(token, secret);
      const { accessToken, idToken, userId } = await this.getAwsAccessToken(jwt);
      this.last_login = Date.now();
      this.accessToken = accessToken;
      this.idToken = idToken;
      this.userId = userId;
    } catch (error) {
      // Do not hammer login when credentials are rejected or the account is locked.
      if (error instanceof CloudCooldownError || error instanceof CloudHttpError) {
        throw this.policy.throttle(null, 15 * 60 * 1000);
      }
      throw error;
    }
    this.logger.debug('Logged in');
  }

  async checkTokenExpiration(): Promise<void> {
    if (LOGIN_EXPIRATION < Date.now() - this.last_login) {
      this.logger.debug('Token expired, logging in again');
      return await this.login();
    }
    return;
  }

  async getDevices(): Promise<BlueAirDeviceDiscovery[]> {
    await this.checkTokenExpiration();

    this.logger.debug('Getting devices...');

    const response = await this.apiCall('/registered-devices', undefined, 'GET');

    if (!response.devices) {
      throw new Error('getDevices error: no devices in response');
    }

    const devices = response.devices as BlueAirDeviceDiscovery[];
    return devices;
  }

  async getDeviceStatus(accountUuid: string, uuids: string[]): Promise<BlueAirDeviceStatus[]> {
    await this.checkTokenExpiration();

    const body = {
      deviceconfigquery: uuids.map((uuid) => ({ id: uuid, r: { r: ['sensors'] } })),
      includestates: true,
      eventsubscription: {
        include: uuids.map((uuid) => ({ filter: { o: `= ${uuid}` } })),
      },
    };
    const userId = this.userId || accountUuid;
    const data = await this.apiCall<BlueAirDeviceStatusResponse>(`/${userId}/r/initial`, body);

    if (!data.deviceInfo) {
      throw new Error('getDeviceStatus error: no deviceInfo in response');
    }

    const deviceStatuses: BlueAirDeviceStatus[] = data.deviceInfo.map((device) => {
      return {
        id: device.id,
        name: device.configuration.di.name,
        sku: device.configuration.di.sku,
        hardware: device.configuration.di.hw,
        sensorStreamTtl: device.configuration.ds?.rt5s?.ttl,
        sensorTimestamps: Object.fromEntries(
          device.sensordata
            .filter((s) => BlueAirDeviceSensorDataMap[s.n])
            .map((s) => [BlueAirDeviceSensorDataMap[s.n], s.t > 0 ? s.t * 1000 : Date.now()]),
        ),
        stateTimestamps: Object.fromEntries(device.states.map((s) => [s.n, s.t > 0 ? s.t * 1000 : Date.now()])),
        historicalSensors: [] as string[],
        supportedSensors: Array.from(new Set([...this.getAvailableSensorNames(device), ...device.sensordata.map((s) => s.n)]))
          .map((name) => BlueAirDeviceSensorDataMap[name])
          .filter((name): name is string => !!name),
        sensorData: device.sensordata.reduce((acc, sensor) => {
          const key = BlueAirDeviceSensorDataMap[sensor.n];
          if (key) {
            acc[key] = sensor.v;
          }
          return acc;
        }, {} as BlueAirDeviceSensorData),
        state: device.states.reduce((acc, state) => {
          if (state.v !== undefined) {
            acc[state.n] = state.v;
          } else if (state.vb !== undefined) {
            acc[state.n] = state.vb;
          } else {
            this.logger.warn(`getDeviceStatus: unknown state ${JSON.stringify(state)}`);
          }
          return acc;
        }, {} as BlueAirDeviceState),
      };
    });

    // For devices that report no air-quality data (e.g. Blue 40/SP4i), fetch from
    // the historical telemetry endpoint which aggregates 5-minute sensor readings.
    // Check for the AQI inputs specifically, not just any sensor data — a device may
    // return non-AQ sensors (fanspeed/temperature/humidity) while still lacking PM/VOC.
    for (const status of deviceStatuses) {
      const missing = (status.supportedSensors ?? []).filter(
        (key) => ['pm1', 'pm2_5', 'pm10', 'voc'].includes(key) && !Number.isFinite(status.sensorData[key]),
      );
      if (missing.length > 0) {
        const deviceInfo = data.deviceInfo.find((d) => d.id === status.id);
        const availableSensors = this.getAvailableSensorNames(deviceInfo);
        if (availableSensors.length > 0) {
          try {
            let cached = this.telemetryCache.get(status.id);
            if (!cached || Date.now() - cached.time >= 300000) {
              cached = { time: Date.now(), data: await this.getDeviceTelemetry(userId, status.id, availableSensors) };
              this.telemetryCache.set(status.id, cached);
            }
            for (const key of missing) {
              if (cached.data[key] !== undefined) {
                status.sensorData[key] = cached.data[key];
                status.sensorTimestamps![key] = this.telemetryTimes.get(status.id)?.[key] ?? cached.time;
                status.historicalSensors!.push(key);
              }
            }
            this.logger.debug(`[${status.name}] Sensor data from telemetry: ${JSON.stringify(cached.data)}`);
          } catch (error) {
            if (error instanceof CloudCooldownError) {
              throw error;
            }
            this.logger.debug(`[${status.name}] Telemetry fallback unavailable`);
          }
        }
      }
    }

    return deviceStatuses;
  }

  private getAvailableSensorNames(deviceInfo?: BlueAirDeviceStatusResponse['deviceInfo'][0]): string[] {
    if (!deviceInfo?.configuration?.ds) {
      return [];
    }
    const knownSensors = new Set(Object.keys(BlueAirDeviceSensorDataMap));
    const available = new Set<string>();
    for (const [key, entry] of Object.entries(deviceInfo.configuration.ds)) {
      if (knownSensors.has(key)) {
        available.add(key);
      }
      if (entry.sn) {
        for (const s of entry.sn) {
          if (knownSensors.has(s)) {
            available.add(s);
          }
        }
      }
    }
    return Array.from(available);
  }

  async getDeviceTelemetry(accountUuid: string, uuid: string, sensorNames: string[]): Promise<BlueAirDeviceSensorData> {
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;

    const params = new URLSearchParams();
    params.append('did', uuid);
    params.append('from', oneHourAgo.toString());
    params.append('to', now.toString());
    for (const sensor of sensorNames) {
      params.append('s', sensor);
    }

    const data = await this.apiCall<BlueAirTelemetryResponse>(
      `/${accountUuid}/r/telemetry/5m/historical?${params.toString()}`,
      undefined,
      'GET',
    );

    if (!Array.isArray(data) || data.length === 0) {
      return {};
    }

    const entry = data.find((e) => e.did === uuid);
    if (!entry?.datapoints || entry.datapoints.length === 0) {
      return {};
    }

    const sensorData: BlueAirDeviceSensorData = {};
    const timestamps: Record<string, number> = {};
    // Sensors can publish at different times; find the newest valid value for each one.
    for (let i = 0; i < entry.sensors.length; i++) {
      const key = BlueAirDeviceSensorDataMap[entry.sensors[i]];
      if (!key) {
        continue;
      }
      for (const row of [...entry.datapoints].reverse()) {
        const raw = row[i + 1];
        if (raw === null || raw === undefined || raw === '') {
          continue;
        }
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) {
          sensorData[key] = value;
          const seconds = Number(row[0]);
          timestamps[key] = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
          break;
        }
      }
    }

    this.telemetryTimes.set(uuid, timestamps);
    return sensorData;
  }

  async setDeviceStatus(uuid: string, state: string, value: number | boolean): Promise<void> {
    await this.checkTokenExpiration();

    // this.logger.debug(`setDeviceStatus: ${uuid} ${state} ${value}`);

    const body: BlueAirSetStateBody = {
      n: state,
    };

    if (typeof value === 'number') {
      body.v = value;
    } else if (typeof value === 'boolean') {
      body.vb = value;
    } else {
      throw new Error(`setDeviceStatus: unknown value type ${typeof value}`);
    }

    // const response = await this.apiCall(`/${uuid}/a/${state}`, body);
    await this.apiCall(`/${uuid}/a/${state}`, body);
    // this.logger.debug(`setDeviceStatus response: ${JSON.stringify(response)}`);
  }

  private async getAwsAccessToken(jwt: string): Promise<{ accessToken: string; idToken: string; userId: string }> {
    this.logger.debug('Getting AWS access token...');

    const response = await this.apiCall('/login', undefined, 'POST', {
      Authorization: `Bearer ${jwt}`,
      idtoken: jwt,
    });

    if (!response.access_token) {
      throw new Error('AWS login returned no access token');
    }

    const accessToken = response.access_token as string;
    const tokenPayload = JSON.parse(Buffer.from(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) as {
      username?: string;
    };

    this.logger.debug('AWS access token received');
    const names = ['Name', 'Signature', 'Token'];
    const headers = Object.fromEntries(
      names.map((name) => [`X-Amz-CustomAuthorizer-${name}`, response[`ba_X-Amz-CustomAuthorizer-${name}`]]),
    );
    this.mqttCredentials =
      names.every((name) => typeof headers[`X-Amz-CustomAuthorizer-${name}`] === 'string') && tokenPayload.username
        ? {
            host:
              this.cloudRegion === Region.CN
                ? 'a2du5f95w7oz2a.ats.iot.cn-north-1.amazonaws.com.cn'
                : `a3tpdpjvxk6yog-ats.iot.${getAwsConfig(this.cloudRegion).awsRegion}.amazonaws.com`,
            userId: tokenPayload.username,
            headers,
            expiresAt: Date.now() + Math.min(LOGIN_EXPIRATION, Math.max(600, Number(response.expires_in) || 86400) * 1000),
          }
        : undefined;
    return {
      accessToken,
      idToken: response.id_token ?? jwt,
      userId: tokenPayload.username ?? '',
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async apiCall<T = any>(url: string, data?: string | object, method = 'POST', headers?: object, retries = 2): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const release = await this.mutex.acquire();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), BLUEAIR_API_TIMEOUT);
      try {
        this.policy.assertReady();
        const response = await fetch(`${this.blueAirApiUrl}${url}`, {
          method,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
            idtoken: this.idToken || this.accessToken,
            ...headers,
          },
          body: data === undefined ? undefined : JSON.stringify(data),
          signal: controller.signal,
        });
        this.logger.debug(`[AWS] ${method} response: ${response.status}`);
        if (response.status === 229 || response.status === 429) {
          throw this.policy.throttle(response.headers.get('retry-after'));
        }
        if (!response.ok) {
          throw new CloudHttpError(response.status);
        }
        const result = await response.json();
        this.policy.success();
        return result as T;
      } catch (error) {
        const transient = !(error instanceof CloudCooldownError) && (!(error instanceof CloudHttpError) || error.status >= 500);
        // Ambiguous device writes are never replayed; the next status poll reconciles them.
        if (!transient || url.includes('/a/') || attempt >= retries) {
          throw error;
        }
      } finally {
        clearTimeout(timeout);
        release();
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt + Math.random() * 250));
    }
  }
}
