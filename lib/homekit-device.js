/**
 * HomeKit device type.
 */
'use strict';

const {Device} = require('gateway-addon');
const {
  Category,
  Characteristic,
  GattClient,
  HttpClient,
  Service,
  TLV,
} = require('hap-controller');
const HomeKitDatabase = require('./homekit-database');
const HomeKitProperty = require('./homekit-property');
const Util = require('./util');

const IgnoredServices = [
  'public.hap.service.pairing',
  'public.hap.service.protocol.information.service',
  'public.hap.service.protocol.service-label',
];

const IgnoredCharacteristics = [
  'public.hap.characteristic.administrator-only-access',
  'public.hap.characteristic.identify',
  'public.hap.characteristic.logs',
  'public.hap.characteristic.lock-management.control-point',
  'public.hap.characteristic.manufacturer',
  'public.hap.characteristic.serial-number',
  'public.hap.characteristic.version',
  'public.hap.characteristic.pairing.pair-setup',
  'public.hap.characteristic.pairing.pair-verify',
  'public.hap.characteristic.pairing.features',
  'public.hap.characteristic.pairing.pairings',
  'public.hap.characteristic.firmware.revision',
  'public.hap.characteristic.hardware.revision',
  'public.hap.characteristic.accessory-properties',
  'public.hap.characteristic.service-label-index',
  'public.hap.characteristic.service-label-namespace',
  'public.hap.characteristic.setup-endpoints',
];

/**
 * HomeKit device type.
 */
class HomeKitDevice extends Device {
  /**
   * Initialize the object.
   *
   * @param {Object} adapter - HomeKitAdapter instance
   * @param {string} connectionType - Type of this connection: "ip" or "ble"
   * @param {Object} service - The service object
   * @param {Object?} bridge - Bridge this device is attached to, if any
   */
  constructor(adapter, connectionType, service, bridge = null) {
    const id = HomeKitDevice.getIdFromService(service, connectionType);
    super(adapter, `homekit-${id}`);

    this.deviceID = id;
    this.gsn = service.GSN;
    this.connectionType = connectionType;
    this.service = service;
    this.subDevices = new Map();
    this.bridge = bridge;
    this.pollInterval = null;
    this.watching = false;

    this.name = HomeKitDevice.getNameFromService(service, connectionType);
    this.description = HomeKitDevice.getDescriptionFromService(
      service,
      connectionType
    );
    this['@context'] = 'https://iot.mozilla.org/schemas';
    this['@type'] = [];
    this.pinPattern = '^\\d{3}-\\d{2}-\\d{3}$';

    if (this.bridge) {
      // Properties will be built from the outside.
      this.promise = Promise.resolve();
      return;
    }

    const database = new HomeKitDatabase(adapter.packageName);
    this.promise = database.open().then(() => {
      return database.loadPairingData(id);
    }).then((pairingData) => {
      this.client = HomeKitDevice.getClientFromService(
        service,
        connectionType,
        pairingData
      );
      this.paired = true;
      this.pinRequired = false;
      return this.addDevicesAndProperties();
    }).then(() => {
      if (this.connectionType === 'ip') {
        this.client.on('event', this.handleCharacteristicEvent.bind(this));

        this.client.on('disconnect', () => {
          this.startWatching().catch(() => {
            setTimeout(() => {
              this.startWatching();
            }, 5 * 1000);
          });
        });
      }

      return this.startWatching();
    }).catch((e) => {
      console.error(`Error loading device ${this.deviceID}: ${e}`);

      return database.loadConfig().then((config) => {
        for (const item of config.pinCodes) {
          if (item.id === this.deviceID) {
            // If the PIN wasn't set, let's just bail here.
            if (!item.pin) {
              this.paired = false;
              this.pinRequired = true;
              database.close();
              return;
            }

            return this.pair(item.pin).then(() => {
              database.close();
            }).catch(() => {
              // If pairing failed, remove the PIN and save the config.
              item.pin = '';
              item.note = this.description;
              database.saveConfig(config).then(() => database.close());
            });
          }
        }

        // If this PIN wasn't found in the database, add a stub for the user to
        // configure.
        this.paired = false;
        this.pinRequired = true;
        config.pinCodes.push({
          id: this.deviceID,
          pin: '',
          note: this.description,
        });

        database.saveConfig(config).then(() => database.close());
      });
    });
  }

  /**
   * Get the device ID from its service data.
   *
   * @param {Object} service - The service object
   * @param {string} connectionType - Type of this connection: "ip" or "ble"
   * @returns {string} Device ID.
   */
  static getIdFromService(service, connectionType) {
    switch (connectionType) {
      case 'ip':
        return service.id;
      case 'ble':
        return service.DeviceID;
      default:
        throw new Error('Unknown connection type');
    }
  }

  /**
   * Get the device name from its service data.
   *
   * @param {Object} service - The service object
   * @param {string} connectionType - Type of this connection: "ip" or "ble"
   * @returns {string} Device name.
   */
  static getNameFromService(service, connectionType) {
    switch (connectionType) {
      case 'ip':
      case 'ble':
        return service.name;
      default:
        throw new Error('Unknown connection type');
    }
  }

  /**
   * Get the device description from its service data.
   *
   * @param {Object} service - The service object
   * @param {string} connectionType - Type of this connection: "ip" or "ble"
   * @returns {string} Device description.
   */
  static getDescriptionFromService(service, connectionType) {
    switch (connectionType) {
      case 'ip':
        return service.md || `${service.name} (${service.id})`;
      case 'ble':
        return `${service.name} (${service.DeviceID})`;
      default:
        throw new Error('Unknown connection type');
    }
  }

  /**
   * Get the device category from its service data.
   *
   * @param {Object} service - The service object
   * @param {string} connectionType - Type of this connection: "ip" or "ble"
   * @returns {number} Device category.
   */
  static getCategoryFromService(service, connectionType) {
    switch (connectionType) {
      case 'ip':
        return service.ci;
      case 'ble':
        return service.ACID;
      default:
        throw new Error('Unknown connection type');
    }
  }

  /**
   * Get a client object from a device's service data.
   *
   * @param {Object} service - The service object
   * @param {string} connectionType - Type of this connection: "ip" or "ble"
   * @returns {Object} Client object.
   */
  static getClientFromService(service, connectionType, pairingData) {
    switch (connectionType) {
      case 'ip':
        return new HttpClient(
          service.id,
          service.address,
          service.port,
          pairingData
        );
      case 'ble':
        return new GattClient(
          service.DeviceID,
          service.peripheral,
          pairingData
        );
      default:
        throw new Error('Unknown connection type');
    }
  }

  /**
   * Remove a device from this bridge.
   *
   * @param {string} deviceId - ID of device to remove
   */
  removeDevice(deviceId) {
    this.subDevices.delete(deviceId);
  }

  /**
   * Search for and add any properties (or sub-devices).
   *
   * @returns {Promise} Promise which resolves when the process completes.
   */
  addDevicesAndProperties() {
    return this.client.getAccessories().then((accessories) => {
      const category = HomeKitDevice.getCategoryFromService(
        this.service,
        this.connectionType
      );
      const isBridge = Category.categoryFromId(category) === 'Bridge';

      const accessoriesToParse = [];
      if (isBridge) {
        for (const acc of accessories.accessories) {
          if (acc.aid === 1) {
            continue;
          }

          accessoriesToParse.push(acc);
        }
      } else {
        for (const acc of accessories.accessories) {
          if (acc.aid === 1) {
            accessoriesToParse.push(acc);
            break;
          }
        }
      }

      return this.parseAccessories(accessoriesToParse, isBridge);
    });
  }

  /**
   * Parse an accessory list, adding properties and devices as necessary.
   *
   * @param {Object[]} accessories - List of accessories
   * @param {boolean} isBridge - Whether or not these accessories are on a
   *                  bridge
   */
  parseAccessories(accessories, isBridge) {
    for (const acc of accessories) {
      let device = this;
      if (isBridge) {
        device = new HomeKitDevice(
          this.adapter,
          this.connectionType,
          this.service,
          this
        );

        const id = `${device.id}-${acc.aid}`;
        device.id = id;

        this.subDevices.set(id, device);
      }

      for (const service of acc.services) {
        const svcType = Service.serviceFromUuid(service.type);

        if (IgnoredServices.includes(svcType) ||
            !svcType.startsWith('public.hap.service.')) {
          continue;
        }

        let hueProp, saturationProp, brightnessProp;

        for (const characteristic of service.characteristics) {
          const chType = Characteristic.characteristicFromUuid(
            characteristic.type
          );

          if (IgnoredCharacteristics.includes(chType) ||
              !chType.startsWith('public.hap.characteristic.')) {
            continue;
          }

          if (svcType === 'public.hap.service.accessory-information') {
            if (chType === 'public.hap.characteristic.name') {
              device.name = characteristic.value;
            } else if (chType === 'public.hap.characteristic.model') {
              device.description = characteristic.value;
            }

            continue;
          } else if (svcType === 'public.hap.service.outlet') {
            HomeKitDevice.addCapability(device, 'SmartPlug');
          } else if (svcType === 'public.hap.service.lightbulb') {
            HomeKitDevice.addCapability(device, 'Light');
          }

          const property = this.addProperty(
            acc.aid,
            service,
            characteristic,
            device
          );

          if (property) {
            if (property.label === 'Hue') {
              hueProp = property;
            } else if (property.label === 'Saturation') {
              saturationProp = property;
            } else if (property.label === 'Brightness') {
              brightnessProp = property;
            }
          }
        }

        if (hueProp && saturationProp && brightnessProp) {
          hueProp.visible = false;
          saturationProp.visible = false;
          brightnessProp.visible = false;

          HomeKitDevice.addCapability(device, 'ColorControl');

          const getColor = () => {
            return Util.hsvToRgb(
              hueProp.value,
              saturationProp.value,
              brightnessProp.value
            );
          };

          const setColor = (value) => {
            const hsv = Util.rgbToHsv(value);
            hueProp.setValue(hsv.h).then(() => {
              return saturationProp.setValue(hsv.s);
            }).then(() => {
              return brightnessProp.setValue(hsv.v);
            });
            return value;
          };

          const colorName =
            `${hueProp.name}-${saturationProp.name}-${brightnessProp.name}`;
          const colorProp = new HomeKitProperty(
            device,
            colorName,
            acc.aid,
            service.type,
            null,
            null,
            null,
            {
              '@type': 'ColorProperty',
              label: 'Color',
              type: 'string',
            },
            null,
            getColor,
            setColor
          );
          colorProp.metaProperty = true;

          hueProp.postUpdate =
            saturationProp.postUpdate =
            brightnessProp.postUpdate = () => {
              const rgb = getColor();
              colorProp.setCachedValue(rgb);
              device.notifyPropertyChanged(colorProp);
            };

          device.properties.set(colorName, colorProp);
        }
      }

      if (isBridge) {
        device.promise.then(() => {
          this.adapter.handleDeviceAdded(device);
        });
      }
    }
  }

  /**
   * Build and add a property.
   *
   * @param {number} aid - Accessory ID
   * @param {Object} service - Service object
   * @param {Object} characteristic - Characteristic object
   * @param {Object} device - Device to add property to
   * @returns {Object} The property that was added.
   */
  addProperty(aid, service, characteristic, device) {
    const chType = Characteristic.characteristicFromUuid(characteristic.type);
    const name = `${aid}-${characteristic.iid}`;

    let property;
    switch (chType) {
      case 'public.hap.characteristic.audio-feedback': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Audio Feedback',
            type: 'boolean',
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.brightness': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BrightnessProperty',
            label: 'Brightness',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.temperature.cooling-threshold': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 10);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 35);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Cooling Threshold Temperature',
            type: 'number',
            unit: 'celsius',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.door-state.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Open',
          1: 'Closed',
          2: 'Opening',
          3: 'Closing',
          4: 'Stopped',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Current Door State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.heating-cooling.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Off',
          1: 'Heat',
          2: 'Cool',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Current Heating/Cooling State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.relative-humidity.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Current Relative Humidity',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.temperature.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Current Temperature',
            type: 'number',
            unit: 'celsius',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.temperature.heating-threshold': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 25);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Heating Threshold Temperature',
            type: 'number',
            unit: 'celsius',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.hue': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 360);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Hue',
            type: 'number',
            unit: 'arcdegrees',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.lock-management.auto-secure-timeout': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Lock Auto-Secure Timeout',
            type: 'number',
            unit: 'seconds',
            minimum: 0,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.lock-mechanism.last-known-action': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Secured using physical movement, interior',
          1: 'Unsecured using physical movement, interior',
          2: 'Secured using physical movement, exterior',
          3: 'Unsecured using physical movement, exterior',
          4: 'Secured with keypad',
          5: 'Unsecured with keypad',
          6: 'Secured remotely',
          7: 'Unsecured remotely',
          8: 'Secured with automatic secure timeout',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Lock Last Known Action',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
        );
        break;
      }
      case 'public.hap.characteristic.lock-mechanism.current-state': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Unsecured',
          1: 'Secured',
          2: 'Jammed',
          3: 'Unknown',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Lock Current State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.lock-mechanism.target-state': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Unsecured',
          1: 'Secured',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Lock Target State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.model': {
        // leave empty, handled elsewhere
        break;
      }
      case 'public.hap.characteristic.motion-detected': {
        HomeKitDevice.addCapability(device, 'MotionSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'MotionProperty',
            label: 'Motion Detected',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.name': {
        // leave empty, handled elsewhere
        break;
      }
      case 'public.hap.characteristic.obstruction-detected': {
        HomeKitDevice.addCapability(device, 'BinarySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Obstruction Detected',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.on': {
        HomeKitDevice.addCapability(device, 'OnOffSwitch');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'OnOffProperty',
            label: 'On',
            type: 'boolean',
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.outlet-in-use': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Outlet In Use',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.rotation.direction': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Clockwise',
          1: 'Counter-clockwise',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Rotation Direction',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.rotation.speed': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Rotation Speed',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.saturation': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Saturation',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.door-state.target': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Open',
          1: 'Closed',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Target Door State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.heating-cooling.target': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Off',
          1: 'Heat',
          2: 'Cool',
          3: 'Auto',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Target Heating/Cooling State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.relative-humidity.target': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Target Relative Humidity',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.temperature.target': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 38);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Target Temperature',
            type: 'number',
            unit: 'celsius',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.temperature.units': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Celsius',
          1: 'Fahrenheit',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Temperature Display Units',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.air-particulate.density': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Air Particulate Density',
            type: 'number',
            unit: 'micrograms/m^3',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.air-particulate.size': {
        const values = HomeKitDevice.filterEnumValues({
          0: '2.5 Micrometers',
          1: '10 Micrometers',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Air Particulate Size',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.security-system-state.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Stay Arm',
          1: 'Away Arm',
          2: 'Night Arm',
          3: 'Disarmed',
          4: 'Alarm Triggered',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Security System Current State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.security-system-state.target': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Stay Arm',
          1: 'Away Arm',
          2: 'Night Arm',
          3: 'Disarm',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Security System Target State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.battery-level': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Battery Level',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.carbon-monoxide.detected': {
        HomeKitDevice.addCapability(device, 'BinarySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Carbon Monoxide Detected',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.contact-state': {
        HomeKitDevice.addCapability(device, 'DoorSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'OpenProperty',
            label: 'Open',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.light-level.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0.0001);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Current Ambient Light Level',
            type: 'number',
            unit: 'lux',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.horizontal-tilt.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, -90);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 90);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Current Horizontal Tilt Angle',
            type: 'number',
            unit: 'arcdegrees',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.position.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Current Position',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.vertical-tilt.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, -90);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 90);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Current Vertical Tilt Angle',
            type: 'number',
            unit: 'arcdegrees',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.position.hold': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Hold Position',
            type: 'boolean',
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.leak-detected': {
        HomeKitDevice.addCapability(device, 'BinarySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Leak Detected',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.occupancy-detected': {
        HomeKitDevice.addCapability(device, 'BinarySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Occupancy Detected',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.position.state': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Going to the minimum value specified in metadata',
          1: 'Going to the maximum value specified in metadata',
          2: 'Stopped',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Position State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.input-event': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Single Press',
          1: 'Double Press',
          2: 'Long Press',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Position State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.status-active': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Status Active',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.smoke-detected': {
        HomeKitDevice.addCapability(device, 'BinarySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Smoke Detected',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.status-fault': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Status Fault',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.status-jammed': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Status Jammed',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.status-lo-batt': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Status Low Battery',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.status-tampered': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Status Tampered',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.horizontal-tilt.target': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, -90);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 90);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Target Horizontal Tilt Angle',
            type: 'number',
            unit: 'arcdegrees',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.position.target': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Target Position',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.vertical-tilt.target': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, -90);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 90);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Target Vertical Tilt Angle',
            type: 'number',
            unit: 'arcdegrees',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.security-system.alarm-type': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'None',
          1: 'Unknown',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Security System Alarm Type',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.charging-state': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Not Charging',
          1: 'Charging',
          2: 'Not Chargeable',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Charging State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.carbon-monoxide.level': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Carbon Monoxide Level',
            type: 'number',
            unit: 'ppm',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.carbon-monoxide.peak-level': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Carbon Monoxide Peak Level',
            type: 'number',
            unit: 'ppm',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.carbon-dioxide.detected': {
        HomeKitDevice.addCapability(device, 'BinarySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Carbon Dioxide Detected',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.carbon-dioxide.level': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Carbon Dioxide Level',
            type: 'number',
            unit: 'ppm',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.carbon-dioxide.peak-level': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Carbon Dioxide Peak Level',
            type: 'number',
            unit: 'ppm',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.air-quality': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Unknown',
          1: 'Excellent',
          2: 'Good',
          3: 'Fair',
          4: 'Inferior',
          5: 'Poor',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Air Quality',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.lock-physical-controls': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Control lock disabled',
          1: 'Control lock enabled',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Lock Physical Controls',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.air-purifier.state.target': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Manual',
          1: 'Auto',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Target Air Purifier State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.air-purifier.state.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Inactive',
          1: 'Idle',
          2: 'Purifying Air',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Current Air Purifier State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.slat.state.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Fixed',
          1: 'Jammed',
          2: 'Swinging',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Current Slat State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.filter.life-level': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Filter Life Level',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.filter.change-indication': {
        HomeKitDevice.addCapability(device, 'BinarySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Filter Change Needed',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.filter.reset-indication': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Reset Filter Indication',
            type: 'boolean',
          },
          characteristic.value,
          (value) => value !== 0,
          (value) => value ? 1 : 0
        );
        break;
      }
      case 'public.hap.characteristic.fan.state.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Inactive',
          1: 'Idle',
          2: 'Blowing Air',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Current Fan State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.active': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Active',
            type: 'boolean',
          },
          characteristic.value,
          (value) => value !== 0,
          (value) => value ? 1 : 0
        );
        break;
      }
      case 'public.hap.characteristic.swing-mode': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Swing Enabled',
            type: 'boolean',
          },
          characteristic.value,
          (value) => value !== 0,
          (value) => value ? 1 : 0
        );
        break;
      }
      case 'public.hap.characteristic.fan.state.target': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Manual',
          1: 'Auto',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Target Fan State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.type.slat': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Horizontal',
          1: 'Vertical',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Target Fan State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.tilt.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, -90);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 90);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Current Tilt Angle',
            type: 'number',
            unit: 'arcdegrees',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.tilt.target': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, -90);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 90);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Target Tilt Angle',
            type: 'number',
            unit: 'arcdegrees',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.density.ozone': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Ozone Density',
            type: 'number',
            unit: 'micrograms/m^3',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.density.no2': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Nitrogen Dioxide Density',
            type: 'number',
            unit: 'micrograms/m^3',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.density.so2': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Sulphur Dioxide Density',
            type: 'number',
            unit: 'micrograms/m^3',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.density.pm25': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'PM2.5 Density',
            type: 'number',
            unit: 'micrograms/m^3',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.density.pm10': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'PM10 Density',
            type: 'number',
            unit: 'micrograms/m^3',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.density.voc': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'MultiLevelSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'VOC Density',
            type: 'number',
            unit: 'micrograms/m^3',
            minimum,
            maximum,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.color-temperature': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 50);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 400);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'ColorTemperatureProperty',
            label: 'Color Temperature',
            type: 'number',
            unit: 'kelvin',
            minimum,
            maximum,
          },
          characteristic.value,
          (value) => 1e6 / value,
          (value) => 1e6 / value
        );
        break;
      }
      case 'public.hap.characteristic.supported-video-stream-configuration': {
        // This is a complex TLV structure, fill in if necessary.
        break;
      }
      case 'public.hap.characteristic.supported-audio-configuration': {
        // This is a complex TLV structure, fill in if necessary.
        break;
      }
      case 'public.hap.characteristic.supported-rtp-configuration': {
        const values = {
          0: 'AES_CM_128_HMAC_SHA1_80',
          1: 'AES_256_CM_HMAC_SHA1_80',
          2: 'Disabled',
        };

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Supported RTP Configuration',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          (value) => {
            const tlv = TLV.decodeBuffer(Buffer.from(value, 'base64'));
            value = tlv['2'];

            if (values.hasOwnProperty(value)) {
              return values[value];
            }

            throw new Error('Invalid enum value');
          }
        );
        break;
      }
      case 'public.hap.characteristic.selected-rtp-stream-configuration': {
        // This is a complex TLV structure, fill in if necessary.
        break;
      }
      case 'public.hap.characteristic.volume': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LevelProperty',
            label: 'Volume',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.mute': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Mute',
            type: 'boolean',
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.night-vision': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Night Vision',
            type: 'boolean',
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.zoom-optical': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, null);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, null);

        const description = {
          label: 'Optical Zoom',
          type: 'number',
        };

        if (minimum !== null) {
          description.minimum = minimum;
        }

        if (maximum !== null) {
          description.maximum = maximum;
        }

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          description,
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.zoom-digital': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, null);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, null);

        const description = {
          label: 'Digital Zoom',
          type: 'number',
        };

        if (minimum !== null) {
          description.minimum = minimum;
        }

        if (maximum !== null) {
          description.maximum = maximum;
        }

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          description,
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.image-rotation': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'No rotation',
          1: 'Rotated 90 degrees to the right',
          2: 'Rotated 180 degrees to the right (flipped vertically)',
          3: 'Rotated 270 degrees to the right',
        }, characteristic);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Image Rotation',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          HomeKitDevice.buildEnumGetter(values),
          HomeKitDevice.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.image-mirror': {
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'BooleanProperty',
            label: 'Image Mirroring',
            type: 'boolean',
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.streaming-status': {
        const values = {
          0: 'Available',
          1: 'In Use',
          2: 'Unavailable',
        };

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            label: 'Streaming Status',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          (value) => {
            const tlv = TLV.decodeBuffer(Buffer.from(value, 'base64'));
            value = tlv['1'];

            if (values.hasOwnProperty(value)) {
              return values[value];
            }

            throw new Error('Invalid enum value');
          }
        );
        break;
      }
    }

    if (property) {
      if (characteristic.description) {
        property.description = characteristic.description;
      }

      device.properties.set(name, property);
    }

    return property;
  }

  /**
   * Add a capability to a device.
   *
   * @param {Object} device - Device to add to
   * @param {string} capability - New capability
   */
  static addCapability(device, capability) {
    const capabilities = new Set(device['@type']);
    capabilities.add(capability);
    device['@type'] = Array.from(capabilities);
  }

  /**
   * Filter a set of enum values.
   *
   * @param {Object} values - Enum values, i.e. {0: 'val1', ...}
   * @param {Object} characteristic - Characteristic object
   * @returns {Object} Filtered values.
   */
  static filterEnumValues(values, characteristic) {
    if (characteristic['valid-values']) {
      for (let k of Object.keys(values)) {
        k = parseInt(k, 10);

        if (!characteristic['valid-values'].includes(k)) {
          delete values[k];
        }
      }
    } else if (characteristic['valid-values-range']) {
      for (let k of Object.keys(values)) {
        k = parseInt(k, 10);

        if (k < characteristic['valid-values-range'][0] ||
            k > characteristic['valid-values-range'][1]) {
          delete values[k];
        }
      }
    }

    return values;
  }

  /**
   * Determine minimum value for a property.
   *
   * @param {Object} characteristic - Characteristic object
   * @param {number} defaultValue - Default minimum value
   * @returns {number} Minimum value.
   */
  static adjustMinimum(characteristic, defaultValue) {
    if (characteristic.hasOwnProperty('minValue')) {
      return characteristic.minValue;
    }

    return defaultValue;
  }

  /**
   * Determine maximum value for a property.
   *
   * @param {Object} characteristic - Characteristic object
   * @param {number} defaultValue - Default maximum value
   * @returns {number} Maximum value.
   */
  static adjustMaximum(characteristic, defaultValue) {
    if (characteristic.hasOwnProperty('maxValue')) {
      return characteristic.maxValue;
    }

    return defaultValue;
  }

  /**
   * Build an enum property value getter.
   *
   * @param {Object} values - Enum values, i.e. {0: 'val1', ...}
   * @returns {function} New function.
   */
  static buildEnumGetter(values) {
    return (value) => {
      if (values.hasOwnProperty(value)) {
        return values[value];
      }

      throw new Error('Invalid enum value');
    };
  }

  /**
   * Build an enum property value setter.
   *
   * @param {Object} values - Enum values, i.e. {0: 'val1', ...}
   * @returns {function} New function.
   */
  static buildEnumSetter(values) {
    return (value) => {
      const v = Object.entries(values).find((entry) => {
        if (entry[1] === value) {
          return true;
        }
      });

      if (v) {
        return parseInt(v[0], 10);
      }

      throw new Error('Invalid enum value');
    };
  }

  /**
   * Attempt to pair with the device.
   *
   * @param {string} pin - PIN to use for pairing
   * @returns {Promise} Promise which resolves when pairing is complete.
   */
  pair(pin) {
    const client = HomeKitDevice.getClientFromService(
      this.service,
      this.connectionType
    );

    let database;
    return client.pairSetup(pin).then(() => {
      database = new HomeKitDatabase(this.adapter.packageName);
      return database.open();
    }).then(() => {
      return database.storePairingData(this.deviceID, client.getLongTermData());
    }).then(() => {
      this.client = client;
      this.paired = true;
      this.pinRequired = false;
      database.close();
      return this.addDevicesAndProperties();
    }).then(() => {
      if (this.watching) {
        return;
      }

      if (this.connectionType === 'ip') {
        this.client.on('event', this.handleCharacteristicEvent.bind(this));

        this.client.on('disconnect', () => {
          this.startWatching().catch(() => {
            setTimeout(() => {
              this.startWatching();
            }, 5 * 1000);
          });
        });
      }

      return this.startWatching();
    }).catch((e) => {
      this.paired = false;
      this.pinRequired = true;

      if (database) {
        database.close();
      }

      console.error(`Pairing failed for device ${this.deviceID}: ${e}`);
      return Promise.reject(e);
    });
  }

  /**
   * Unpair from the device.
   *
   * @returns {Promise} Promise which resolves when the device is unpaired.
   */
  unpair() {
    return this.client.removePairing(
      this.client.pairingProtocol.iOSDevicePairingID
    ).catch(() => {});
  }

  /**
   * Trigger a property update.
   *
   * @param {number} gsn - New GSN
   */
  triggerBLEUpdate(gsn) {
    this.gsn = gsn;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.readBLECharacteristics().then(() => {
      this.startWatching();
    });
  }

  /**
   * Read all BLE characteristics that are mapped to properties.
   *
   * @returns {Promise} Promise which resolves when the process has completed.
   */
  readBLECharacteristics() {
    const characteristics = Array.from(this.properties.values())
      .filter((p) => p.iid !== null)
      .map((p) => {
        return {
          serviceUuid: p.serviceType,
          characteristicUuid: p.characteristicType,
          iid: p.iid,
          format: p.hapFormat,
        };
      });

    return this.client.getCharacteristics(characteristics)
      .then((result) => {
        this.handleCharacteristicEvent(result);
      })
      .catch(() => {});
  }

  /**
   * Start watching for property events.
   *
   * @returns {Promise} Promise which resolves when subscriptions have been
   *                    started.
   */
  startWatching() {
    this.watching = true;

    switch (this.connectionType) {
      case 'ip': {
        let characteristics;
        if (this.subDevices.size > 0) {
          characteristics = [].concat.apply(
            [],
            Array.from(this.subDevices.values())
              .map((d) => {
                return Array.from(d.properties.values())
                  .filter((p) => p.iid !== null)
                  .map((p) => `${p.aid}.${p.iid}`);
              })
          );
        } else {
          characteristics = Array.from(this.properties.values())
            .filter((p) => p.iid !== null)
            .map((p) => `${p.aid}.${p.iid}`);
        }

        return this.client.subscribeCharacteristics(characteristics);
      }
      case 'ble': {
        // With BLE devices, we poll, rather than subscribing, for 3 reasons:
        // 1. Bluetooth adapters can only have a limited number of open
        //    connections.
        // 2. Keeping an active connection requires that you refresh the
        //    security session frequently, otherwise the connection will drop.
        // 3. We're also watching for disconnected events, which should be
        //    sufficient for time-critical properties.
        this.pollInterval = setInterval(() => {
          this.readBLECharacteristics();
        }, 30 * 1000);

        return Promise.resolve();
      }
      default:
        throw new Error('Unknown connection type');
    }
  }

  /**
   * Handle a characteristic update.
   *
   * @param {Object} event - Update event
   */
  handleCharacteristicEvent(event) {
    let devices;
    if (this.subDevices.size > 0) {
      devices = Array.from(this.subDevices.values());
    } else {
      devices = [this];
    }

    for (const characteristic of event.characteristics) {
      for (const device of devices) {
        for (const property of device.properties.values()) {
          if (property.aid === characteristic.aid &&
              property.iid === characteristic.iid) {
            property.setCachedValue(characteristic.value);
            device.notifyPropertyChanged(property);
            break;
          }
        }
      }
    }
  }
}

module.exports = HomeKitDevice;
