import { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { BlueAirPlatform } from '../platform';
import { BlueAirDevice } from '../device/BlueAirDevice';
import { AutoModeStrategy, getAutoModeStrategy } from '../device/AutoModeStrategy';
import { DeviceConfig } from '../platformUtils';
import { FullBlueAirDeviceState } from '../api/BlueAirAwsApi';
import { CoalescedControl } from '../device/CoalescedControl';

export class AirPurifierAccessory {
  private service: Service;
  private filterMaintenanceService?: Service;
  private ledService?: Service;
  private airQualityService?: Service;
  private temperatureService?: Service;
  private germShieldService?: Service;
  private nightModeService?: Service;
  private autoModeStrategy: AutoModeStrategy;
  private speedControl?: CoalescedControl;
  private pm1Characteristic?: Characteristic;
  private readonly pm1Uuid = '7B945FD2-3854-4F43-A229-924D029F62D8';

  constructor(
    protected readonly platform: BlueAirPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly device: BlueAirDevice,
    protected readonly configDev: DeviceConfig,
  ) {
    this.autoModeStrategy = getAutoModeStrategy(this.device.deviceType);
    this.speedControl = new CoalescedControl((value) => this.applyRotationSpeed(value), this.platform.config.sliderBufferMs ?? 350);
    this.platform.on('shutdown', () => this.speedControl?.cancel());

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'BlueAir')
      .setCharacteristic(this.platform.Characteristic.Model, this.configDev.model || this.device.sku || 'BlueAir Purifier')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.configDev.serialNumber || this.device.id);

    this.service =
      this.accessory.getService(this.platform.Service.AirPurifier) || this.accessory.addService(this.platform.Service.AirPurifier);
    this.service.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.configDev.name);
    this.service.getCharacteristic(this.platform.Characteristic.Active).onGet(this.getActive.bind(this)).onSet(this.setActive.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentAirPurifierState).onGet(this.getCurrentAirPurifierState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetAirPurifierState)
      .onGet(this.getTargetAirPurifierState.bind(this))
      .onSet(this.setTargetAirPurifierState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .onGet(this.getLockPhysicalControls.bind(this))
      .onSet(this.setLockPhysicalControls.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    this.filterMaintenanceService =
      this.accessory.getService(this.platform.Service.FilterMaintenance) ||
      this.accessory.addService(this.platform.Service.FilterMaintenance);

    this.filterMaintenanceService
      .getCharacteristic(this.platform.Characteristic.FilterChangeIndication)
      .onGet(this.getFilterChangeIndication.bind(this));

    this.filterMaintenanceService.getCharacteristic(this.platform.Characteristic.FilterLifeLevel).onGet(this.getFilterLifeLevel.bind(this));

    this.ledService = this.accessory.getServiceById(this.platform.Service.Lightbulb, 'Led');
    if (this.configDev.led) {
      this.ledService ??= this.accessory.addService(this.platform.Service.Lightbulb, `${this.device.name} Led`, 'Led');
      this.ledService.setCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Led`);
      this.ledService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
      this.ledService.setCharacteristic(this.platform.Characteristic.ConfiguredName, `${this.device.name} Led`);
      this.ledService.getCharacteristic(this.platform.Characteristic.On).onGet(this.getLedOn.bind(this)).onSet(this.setLedOn.bind(this));
      this.ledService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(this.getLedBrightness.bind(this))
        .onSet(this.setLedBrightness.bind(this));
    } else if (this.ledService) {
      this.accessory.removeService(this.ledService);
    }

    this.airQualityService = this.accessory.getServiceById(this.platform.Service.AirQualitySensor, 'AirQuality');
    if (this.configDev.airQualitySensor) {
      this.airQualityService ??= this.accessory.addService(
        this.platform.Service.AirQualitySensor,
        `${this.device.name} Air Quality`,
        'AirQuality',
      );
      this.airQualityService.getCharacteristic(this.platform.Characteristic.AirQuality).onGet(this.getAirQuality.bind(this));
      for (const [key, characteristic] of [
        ['pm2_5', this.platform.Characteristic.PM2_5Density],
        ['pm10', this.platform.Characteristic.PM10Density],
        ['voc', this.platform.Characteristic.VOCDensity],
      ] as const) {
        if (this.device.supportedSensors.has(key)) {
          this.airQualityService.getCharacteristic(characteristic).onGet(() => this.getDensity(key));
        } else {
          const obsolete = this.airQualityService.characteristics.find((item) => item.UUID === characteristic.UUID);
          if (obsolete) {
            this.airQualityService.removeCharacteristic(obsolete);
          }
        }
      }
      if (this.device.supportedSensors.has('pm1')) {
        this.pm1Characteristic = this.airQualityService.characteristics.find((item) => item.UUID === this.pm1Uuid);
        if (!this.pm1Characteristic) {
          this.pm1Characteristic = new this.platform.Characteristic('PM1 Density', this.pm1Uuid, {
            format: this.platform.Characteristic.Formats.FLOAT,
            unit: '�g/m�',
            minValue: 0,
            maxValue: 1000,
            minStep: 0.1,
            perms: [this.platform.Characteristic.Perms.PAIRED_READ, this.platform.Characteristic.Perms.NOTIFY],
          });
          this.airQualityService.addCharacteristic(this.pm1Characteristic);
        }
        this.pm1Characteristic.onGet(() => this.getDensity('pm1'));
      }
    } else if (this.airQualityService) {
      this.accessory.removeService(this.airQualityService);
    }

    this.temperatureService = this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'Temperature');
    if (this.configDev.temperatureSensor) {
      this.temperatureService ??= this.accessory.addService(
        this.platform.Service.TemperatureSensor,
        `${this.device.name} Temperature`,
        'Temperature',
      );
      this.temperatureService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
    } else if (this.temperatureService) {
      this.accessory.removeService(this.temperatureService);
    }

    this.germShieldService = this.accessory.getServiceById(this.platform.Service.Switch, 'GermShield');
    if (this.configDev.germShield) {
      this.germShieldService ??= this.accessory.addService(this.platform.Service.Switch, `${this.device.name} Germ Shield`, 'GermShield');
      this.germShieldService.setCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Germ Shield`);
      this.germShieldService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
      this.germShieldService.setCharacteristic(this.platform.Characteristic.ConfiguredName, `${this.device.name} Germ Shield`);
      this.germShieldService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getGermShield.bind(this))
        .onSet(this.setGermShield.bind(this));
    } else if (this.germShieldService) {
      this.accessory.removeService(this.germShieldService);
    }

    this.nightModeService = this.accessory.getServiceById(this.platform.Service.Switch, 'NightMode');
    if (this.configDev.nightMode) {
      this.nightModeService ??= this.accessory.addService(this.platform.Service.Switch, `${this.device.name} Night Mode`, 'NightMode');
      this.nightModeService.setCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Night Mode`);
      this.nightModeService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
      this.nightModeService.setCharacteristic(this.platform.Characteristic.ConfiguredName, `${this.device.name} Night Mode`);
      this.nightModeService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getNightMode.bind(this))
        .onSet(this.setNightMode.bind(this));
    } else if (this.nightModeService) {
      this.accessory.removeService(this.nightModeService);
    }

    this.device.on('stateUpdated', this.updateCharacteristics.bind(this));
    this.device.on('availability', (available) => {
      const fault = available ? 0 : 1;
      this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, fault);
      this.airQualityService?.updateCharacteristic(this.platform.Characteristic.StatusFault, fault);
      if (!available) {
        this.airQualityService?.updateCharacteristic(this.platform.Characteristic.AirQuality, 0);
      } else {
        this.airQualityService?.updateCharacteristic(this.platform.Characteristic.AirQuality, this.getAirQuality());
      }
    });
  }

  updateCharacteristics(changedStates: Partial<FullBlueAirDeviceState>) {
    for (const [k, v] of Object.entries(changedStates)) {
      this.platform.log.debug(`[${this.device.name}] ${k} changed to ${v}}`);
      let updateState = false;
      let updateAirQuality = false;
      switch (k) {
        case 'standby':
          updateState = true;
          break;
        case 'automode':
        case 'apsubmode':
          this.service.updateCharacteristic(this.platform.Characteristic.TargetAirPurifierState, this.getTargetAirPurifierState());
          break;
        case 'childlock':
          this.service.updateCharacteristic(this.platform.Characteristic.LockPhysicalControls, this.getLockPhysicalControls());
          break;
        case 'fanspeed':
          this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getRotationSpeed());
          this.service.updateCharacteristic(this.platform.Characteristic.Active, this.getActive());
          this.service.updateCharacteristic(this.platform.Characteristic.CurrentAirPurifierState, this.getCurrentAirPurifierState());
          break;
        case 'filterusage':
          this.filterMaintenanceService?.updateCharacteristic(
            this.platform.Characteristic.FilterChangeIndication,
            this.getFilterChangeIndication(),
          );
          this.filterMaintenanceService?.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, this.getFilterLifeLevel());
          break;
        case 'temperature':
          this.temperatureService?.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature());
          break;
        case 'brightness':
          this.ledService?.updateCharacteristic(this.platform.Characteristic.On, this.getLedOn());
          this.ledService?.updateCharacteristic(this.platform.Characteristic.Brightness, this.getLedBrightness());
          break;
        case 'aqi':
          updateAirQuality = true;
          break;
        case 'pm1':
          this.pm1Characteristic?.updateValue(this.sensorValue('pm1'));
          break;
        case 'pm2_5':
          if (this.device.supportedSensors.has('pm2_5')) {
            this.airQualityService?.getCharacteristic(this.platform.Characteristic.PM2_5Density).updateValue(this.sensorValue('pm2_5'));
          }
          updateAirQuality = true;
          break;
        case 'pm10':
          if (this.device.supportedSensors.has('pm10')) {
            this.airQualityService?.getCharacteristic(this.platform.Characteristic.PM10Density).updateValue(this.sensorValue('pm10'));
          }
          updateAirQuality = true;
          break;
        case 'voc':
          if (this.device.supportedSensors.has('voc')) {
            this.airQualityService?.getCharacteristic(this.platform.Characteristic.VOCDensity).updateValue(this.sensorValue('voc'));
          }
          updateAirQuality = true;
          break;
        case 'germshield':
          this.germShieldService?.updateCharacteristic(this.platform.Characteristic.On, this.getGermShield());
          break;
        case 'nightmode':
          this.nightModeService?.updateCharacteristic(this.platform.Characteristic.On, this.getNightMode());
          break;
      }

      if (updateState) {
        this.service.updateCharacteristic(this.platform.Characteristic.Active, this.getActive());
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentAirPurifierState, this.getCurrentAirPurifierState());
        this.service.updateCharacteristic(this.platform.Characteristic.TargetAirPurifierState, this.getTargetAirPurifierState());
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getRotationSpeed());
        this.ledService?.updateCharacteristic(this.platform.Characteristic.On, this.getLedOn());
        this.germShieldService?.updateCharacteristic(this.platform.Characteristic.On, this.getGermShield());
        this.nightModeService?.updateCharacteristic(this.platform.Characteristic.On, this.getNightMode());
      }

      if (updateAirQuality) {
        this.airQualityService?.updateCharacteristic(this.platform.Characteristic.AirQuality, this.getAirQuality());
      }
    }
  }

  getActive(): CharacteristicValue {
    return this.device.state.standby === false ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  async setActive(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting active to ${value}`);
    if (value === this.platform.Characteristic.Active.INACTIVE) {
      this.speedControl?.cancel();
    }
    await this.device.setState('standby', value === this.platform.Characteristic.Active.INACTIVE);
  }

  getCurrentAirPurifierState(): CharacteristicValue {
    if (this.device.state.standby === false) {
      return this.device.state.fanspeed === 0
        ? this.platform.Characteristic.CurrentAirPurifierState.IDLE
        : this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
    }

    return this.platform.Characteristic.CurrentAirPurifierState.INACTIVE;
  }

  getTargetAirPurifierState(): CharacteristicValue {
    return this.autoModeStrategy.isAuto(this.device.state)
      ? this.platform.Characteristic.TargetAirPurifierState.AUTO
      : this.platform.Characteristic.TargetAirPurifierState.MANUAL;
  }

  async setTargetAirPurifierState(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting target air purifier state to ${value}`);
    const { attribute, value: attributeValue } = this.autoModeStrategy.setAuto(
      value === this.platform.Characteristic.TargetAirPurifierState.AUTO,
    );
    await this.device.setState(attribute, attributeValue);
  }

  getLockPhysicalControls(): CharacteristicValue {
    return this.device.state.childlock
      ? this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
      : this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
  }

  async setLockPhysicalControls(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting lock physical controls to ${value}`);
    await this.device.setState('childlock', value === this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED);
  }

  getRotationSpeed(): CharacteristicValue {
    if (this.device.state.standby !== false) {
      return 0;
    }
    const maximum = this.device.hardware?.startsWith('nb_') || this.device.hardware?.startsWith('high') ? 91 : 100;
    return Math.min(100, Math.round(((this.device.state.fanspeed || 0) * 100) / maximum));
  }

  async setRotationSpeed(value: CharacteristicValue) {
    const speed = Number(value);
    if (!Number.isFinite(speed) || speed < 0 || speed > 100) {
      throw new Error('Fan speed must be between 0 and 100');
    }
    if (this.speedControl) {
      return this.speedControl.submit(speed);
    }
    return this.applyRotationSpeed(speed);
  }

  private async applyRotationSpeed(value: number) {
    this.platform.log.debug(`[${this.device.name}] Setting rotation speed to ${value}`);

    const maximum = this.device.hardware?.startsWith('nb_') || this.device.hardware?.startsWith('high') ? 91 : 100;
    const speed = Math.round((value * maximum) / 100);
    if (speed > 0 && this.device.state.nightmode === true) {
      await this.device.setState('nightmode', false);
    }
    if (speed > 0 && this.device.state.standby === true) {
      await this.device.setState('standby', false);
    }

    const manualMode = this.autoModeStrategy.setAuto(false);
    if (speed > 0 && manualMode.attribute in this.device.state && this.device.state[manualMode.attribute] !== manualMode.value) {
      await this.device.setState(manualMode.attribute, manualMode.value);
    }

    await this.device.setState('fanspeed', speed);
  }

  getFilterChangeIndication(): CharacteristicValue {
    return this.device.state.filterusage !== undefined && this.device.state.filterusage >= this.configDev.filterChangeLevel
      ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
      : this.platform.Characteristic.FilterChangeIndication.FILTER_OK;
  }

  getFilterLifeLevel(): CharacteristicValue {
    const usage = this.device.state.filterusage;
    if (usage === undefined || !Number.isFinite(usage)) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return Math.min(100, Math.max(0, 100 - usage));
  }

  getCurrentTemperature(): CharacteristicValue {
    return this.device.sensorData.temperature || 0;
  }

  getLedOn(): CharacteristicValue {
    return this.device.state.brightness !== undefined && this.device.state.brightness > 0 && this.device.state.nightmode !== true;
  }

  async setLedOn(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting LED on to ${value}`);
    await this.device.setLedOn(value as boolean);
  }

  getLedBrightness(): CharacteristicValue {
    return this.device.state.brightness || 0;
  }

  async setLedBrightness(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting LED brightness to ${value}`);
    await this.device.setState('brightness', value as number);
  }

  private sensorValue(key: string): number | Error {
    const value = this.device.sensorData[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private getDensity(key: string): CharacteristicValue {
    const value = this.sensorValue(key);
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }

  getPM2_5Density(): CharacteristicValue {
    return this.getDensity('pm2_5');
  }

  getPM10Density(): CharacteristicValue {
    return this.getDensity('pm10');
  }

  getVOCDensity(): CharacteristicValue {
    return this.getDensity('voc');
  }

  getAirQuality(): CharacteristicValue {
    if (this.device.sensorData.aqi === undefined) {
      return this.platform.Characteristic.AirQuality.UNKNOWN;
    }

    if (this.device.sensorData.aqi <= 50) {
      return this.platform.Characteristic.AirQuality.EXCELLENT;
    } else if (this.device.sensorData.aqi <= 100) {
      return this.platform.Characteristic.AirQuality.GOOD;
    } else if (this.device.sensorData.aqi <= 150) {
      return this.platform.Characteristic.AirQuality.FAIR;
    } else if (this.device.sensorData.aqi <= 200) {
      return this.platform.Characteristic.AirQuality.INFERIOR;
    } else {
      return this.platform.Characteristic.AirQuality.POOR;
    }
  }

  getGermShield(): CharacteristicValue {
    return this.device.state.germshield === true;
  }

  async setGermShield(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting germ shield to ${value}`);
    await this.device.setState('germshield', value as boolean);
  }

  getNightMode(): CharacteristicValue {
    return this.device.state.nightmode === true;
  }

  async setNightMode(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting night mode to ${value}`);
    await this.device.setState('nightmode', value as boolean);
  }
}
