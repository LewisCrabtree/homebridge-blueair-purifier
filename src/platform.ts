import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Config, defaultConfig, defaultDeviceConfig } from './platformUtils';
import { defaultsDeep } from 'lodash';
import BlueAirAwsApi, { BlueAirDeviceStatus } from './api/BlueAirAwsApi';
import { BlueAirDevice } from './device/BlueAirDevice';
import { AirPurifierAccessory } from './accessory/AirPurifierAccessory';
import EventEmitter from 'events';
import { Mutex } from 'async-mutex';

export class BlueAirPlatform extends EventEmitter implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  private readonly platformConfig: Config;
  private readonly blueAirApi!: BlueAirAwsApi;

  private existingUuids: string[] = [];

  private devices: BlueAirDevice[] = [];
  private polling: NodeJS.Timeout | null = null;
  private readonly operationMutex = new Mutex();
  private stopped = false;
  private initialized = false;
  private pollingInFlight = false;
  private pollFailures = 0;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    super();
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.platformConfig = defaultsDeep(config, defaultConfig);
    const buffer = this.platformConfig.sliderBufferMs;
    this.platformConfig.sliderBufferMs = Number.isFinite(buffer) ? Math.max(0, Math.min(2000, buffer)) : 350;
    const interval = this.platformConfig.pollingInterval;
    this.platformConfig.pollingInterval = Number.isFinite(interval) ? Math.max(60000, interval) : 60000;
    this.log.debug('Finished initializing platform:', this.platformConfig.name);

    if (!this.platformConfig.username || !this.platformConfig.password || !this.platformConfig.accountUuid) {
      this.log.error(
        'Missing required configuration options! Please do the device discovery in the configuration UI and/or check your\
      config.json file',
      );
      return;
    }

    this.blueAirApi = new BlueAirAwsApi(
      this.platformConfig.username,
      this.platformConfig.password,
      this.platformConfig.region,
      log,
      this.platformConfig.cloudRegion ?? this.platformConfig.region,
    );

    this.api.on('didFinishLaunching', () => {
      void this.getValidDevicesStatus();
    });
    this.api.on('shutdown', () => {
      this.stopped = true;
      if (this.polling) {
        clearTimeout(this.polling);
      }
      this.emit('shutdown');
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private schedulePolling() {
    if (this.polling) {
      clearTimeout(this.polling);
    }
    if (this.stopped) {
      return;
    }
    const delay = Math.max(
      this.platformConfig.pollingInterval,
      this.blueAirApi.cooldownMs,
      Math.min(1800000, this.platformConfig.pollingInterval * 2 ** Math.min(this.pollFailures, 5)),
    );
    this.polling = setTimeout(() => {
      void this.getValidDevicesStatus();
    }, delay);
  }

  async getValidDevicesStatus() {
    if (this.stopped || this.pollingInFlight) {
      return;
    }
    this.pollingInFlight = true;
    try {
      await this.operationMutex.runExclusive(async () => {
        if (this.stopped) {
          return;
        }
        if (!this.initialized) {
          await this.getInitialDeviceStates();
        } else {
          const statuses = await this.blueAirApi.getDeviceStatus(this.platformConfig.accountUuid, this.existingUuids);
          if (this.stopped) {
            return;
          }
          for (const device of this.devices) {
            const status = statuses.find((item) => item.id === device.id);
            if (status) {
              device.updateState(status);
            }
            device.emit('availability', !!status);
          }
        }
      });
      this.pollFailures = Math.max(0, this.pollFailures - 1);
    } catch (error) {
      this.pollFailures++;
      for (const device of this.devices) {
        device.emit('availability', false);
      }
      this.log.warn(`Blueair refresh failed: ${(error as Error).message}. Recovery uses backoff.`);
    } finally {
      this.pollingInFlight = false;
      this.schedulePolling();
    }
  }

  async getInitialDeviceStates() {
    this.log.info('Getting initial Blueair device states...');
    const uuids = this.platformConfig.devices.map((device) => device.id);
    if (uuids.length === 0) {
      throw new Error('No Blueair devices configured; use Discover Devices');
    }
    const statuses = await this.blueAirApi.getDeviceStatus(this.platformConfig.accountUuid, uuids);
    if (this.stopped) {
      return;
    }
    for (const status of statuses) {
      if (uuids.includes(status.id)) {
        const existingDevice = this.devices.find((device) => device.id === status.id);
        if (existingDevice) {
          existingDevice.updateState(status);
          existingDevice.emit('availability', true);
        } else {
          await this.addDevice(status);
        }
      }
    }
    this.initialized = this.devices.length === uuids.length;
    if (!this.initialized) {
      throw new Error('Some configured Blueair devices are missing from the cloud response');
    }
  }

  async addDevice(device: BlueAirDeviceStatus) {
    const uuid = this.api.hap.uuid.generate(device.id);
    const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
    const deviceConfig = this.platformConfig.devices.find((config) => config.id === device.id);

    if (!deviceConfig) {
      this.log.error(`[${device.name}] Device configuration not found!`);
      return;
    }

    defaultsDeep(deviceConfig, defaultDeviceConfig);
    this.existingUuids.push(device.id);
    const blueAirDevice = new BlueAirDevice(device, async (attribute, value) => {
      if (this.stopped) {
        throw new Error('Blueair bridge is shutting down');
      }
      if (this.polling) {
        clearTimeout(this.polling);
      }
      try {
        await this.operationMutex.runExclusive(() => {
          if (this.stopped) {
            throw new Error('Blueair bridge is shutting down');
          }
          return this.blueAirApi.setDeviceStatus(device.id, attribute, value);
        });
      } catch (error) {
        blueAirDevice.emit('availability', false);
        throw error;
      } finally {
        this.schedulePolling();
      }
    });
    this.log.info(`[${device.name}] Device type is ${blueAirDevice.deviceType}`);
    this.devices.push(blueAirDevice);

    if (existingAccessory) {
      this.log.info(`[${deviceConfig.name}] Restoring existing accessory from cache: ${existingAccessory.displayName}`);
      new AirPurifierAccessory(this, existingAccessory, blueAirDevice, deviceConfig);
    } else {
      this.log.info('Adding new accessory:', device.name);
      const accessory = new this.api.platformAccessory(device.name, uuid);
      new AirPurifierAccessory(this, accessory, blueAirDevice, deviceConfig);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}
