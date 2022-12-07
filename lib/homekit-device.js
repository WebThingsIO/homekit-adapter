/**
 * HomeKit device type.
 */
'use strict';

const {Device, Event} = require('gateway-addon');
const {
  Category,
  Characteristic,
  GattClient,
  HttpClient,
  Service,
  TLV,
} = require('hap-controller');
const HomeKitProperty = require('./homekit-property');
const PropertyUtils = require('./property-utils');
const Util = require('./util');
const VendorExtensions = require('./vendor-extensions');

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
  'public.hap.characteristic.setup-data-stream-transport',
  'public.hap.characteristic.button-event',
  'public.hap.characteristic.siri-input-type',
  'public.hap.characteristic.selected-rtp-stream-configuration',
  'public.hap.characteristic.selected-audio-stream-configuration',
  'public.hap.characteristic.supported-video-stream-configuration',
  'public.hap.characteristic.supported-audio-configuration',
  'public.hap.characteristic.supported-target-configuration',
  'public.hap.characteristic.target-list',
  'public.hap.characteristic.active-identifier',
];

const BLE_POLL_INTERVAL = 5 * 60 * 1000;  // 5 minutes
const SKIP_QUEUE = true;
const TRIGGERED_BY_EVENT = true;

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
    this.readPromise = null;
    this.pollTimeout = null;
    this.watching = false;
    this.pendingPairingData = null;
    this.pendingPairingClient = null;
    this.actionCallbacks = new Map();

    this.name = HomeKitDevice.getNameFromService(service, connectionType);
    this.description = HomeKitDevice.getDescriptionFromService(
      service,
      connectionType
    );
    this['@context'] = 'https://iot.mozilla.org/schemas';
    this['@type'] = [];
    this.pinPattern = '^(\\d{3}-\\d{2}-\\d{3}|\\d{8})$';

    if (this.bridge) {
      // Properties will be built from the outside.
      this.promise = Promise.resolve();
      return;
    }

    this.promise = this.adapter.db.loadPairingData(id).then((pairingData) => {
      if (!pairingData) {
        throw new Error('no pairing data available');
      }

      if (typeof pairingData === 'string') {
        pairingData = JSON.parse(pairingData);
      }

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
      console.log(`Error loading device ${this.deviceID}:`, e);
      this.paired = false;
      this.pinRequired = true;
    });
  }

  asDict() {
    const dict = super.asDict();

    // Remove invisible properties since they are no longer supported
    for (const [name, prop] of this.properties) {
      if (!prop.visible) {
        delete dict.properties[name];
      }
    }

    return dict;
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
   * @param {boolean} skipQueue - Whether or not to skip BLE queue
   * @returns {Promise} Promise which resolves when the process completes.
   */
  addDevicesAndProperties(skipQueue = false) {
    const fn = () => {
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
      }).catch((e) => {
        // If we timed out or disconnected and the device is BLE, retry.
        if (this.connectionType === 'ble' && typeof e === 'string' &&
            (e === 'Disconnected' || e === 'Timeout')) {
          return fn();
        }

        return Promise.reject(e);
      });
    };

    if (this.connectionType === 'ble' && !skipQueue) {
      return this.adapter.queueBLEOperation(fn);
    }

    return fn();
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

        console.debug(`[Device ${this.deviceID}] Found service: ${svcType}`);

        if (IgnoredServices.includes(svcType) ||
            !svcType.startsWith('public.hap.service.')) {
          continue;
        }

        let hueProp, saturationProp, brightnessProp;

        for (const characteristic of service.characteristics) {
          const chType = Characteristic.characteristicFromUuid(
            characteristic.type
          );

          console.debug(`[Device ${this.deviceID}] Found characteristic: ${
            chType}\n${JSON.stringify(characteristic, null, 2)}`);

          if (IgnoredCharacteristics.includes(chType)) {
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
          } else if (svcType === 'public.hap.service.thermostat') {
            HomeKitDevice.addCapability(device, 'Thermostat');
          } else if (svcType === 'public.hap.service.lock-mechanism') {
            HomeKitDevice.addCapability(device, 'Lock');
          }

          const property = this.addProperty(
            acc.aid,
            service,
            characteristic,
            device
          );

          if (property) {
            if (property.title === 'Hue') {
              hueProp = property;
            } else if (property.title === 'Saturation') {
              saturationProp = property;
            } else if (property.title === 'Brightness') {
              brightnessProp = property;
            }

            if (property['@type'] === 'InstantaneousPowerProperty') {
              HomeKitDevice.addCapability(device, 'EnergyMonitor');
            }
          }
        }

        if (hueProp && saturationProp && brightnessProp) {
          hueProp.visible = false;
          saturationProp.visible = false;

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
              title: 'Color',
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
            title: 'Audio Feedback',
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
            title: 'Brightness',
            type: 'integer',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Cooling Threshold Temperature',
            type: 'number',
            unit: 'degree celsius',
            minimum,
            maximum,
            multipleOf: 0.1,
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
            title: 'Current Door State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.heating-cooling.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'off',
          1: 'heating',
          2: 'cooling',
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
            '@type': 'HeatingCoolingProperty',
            title: 'Current Heating/Cooling State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.relative-humidity.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'HumiditySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'HumidityProperty',
            title: 'Current Relative Humidity',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.temperature.current': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'TemperatureSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'TemperatureProperty',
            title: 'Current Temperature',
            type: 'number',
            unit: 'degree celsius',
            minimum,
            maximum,
            multipleOf: 0.1,
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
            title: 'Heating Threshold Temperature',
            type: 'number',
            unit: 'degree celsius',
            minimum,
            maximum,
            multipleOf: 0.1,
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
            title: 'Hue',
            type: 'number',
            unit: 'arcdegrees',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Lock Auto-Secure Timeout',
            type: 'integer',
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
            title: 'Lock Last Known Action',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
        );
        break;
      }
      case 'public.hap.characteristic.lock-mechanism.current-state': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'unlocked',
          1: 'locked',
          2: 'jammed',
          3: 'unknown',
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
            '@type': 'LockedProperty',
            title: 'Lock Current State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.lock-mechanism.target-state': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'unlocked',
          1: 'locked',
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
            '@type': 'TargetLockedProperty',
            title: 'Lock Target State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
        );

        property.visible = false;

        if (values[0]) {
          device.addAction(
            'unlock',
            {
              '@type': 'UnlockAction',
              title: 'Unlock',
              description: 'Unlock the locking mechanism',
            }
          );
        }

        if (values[1]) {
          device.addAction(
            'lock',
            {
              '@type': 'LockAction',
              title: 'Lock',
              description: 'Lock the locking mechanism',
            }
          );
        }

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
            title: 'Motion Detected',
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
            title: 'Obstruction Detected',
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
            title: 'On',
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
            title: 'Outlet In Use',
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
            title: 'Rotation Direction',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
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
            title: 'Rotation Speed',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Saturation',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Target Door State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.heating-cooling.target': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'off',
          1: 'heat',
          2: 'cool',
          3: 'auto',
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
            '@type': 'ThermostatModeProperty',
            title: 'Target Heating/Cooling State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
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
            title: 'Target Relative Humidity',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            '@type': 'TargetTemperatureProperty',
            title: 'Target Temperature',
            type: 'number',
            unit: 'degree celsius',
            minimum,
            maximum,
            multipleOf: 0.1,
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
            title: 'Temperature Display Units',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.air-particulate.density': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'DensityProperty',
            title: 'Air Particulate Density',
            type: 'number',
            unit: 'micrograms per cubic meter',
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
            title: 'Air Particulate Size',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Security System Current State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Security System Target State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
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
            title: 'Battery Level',
            type: 'integer',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Carbon Monoxide Detected',
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
            title: 'Open',
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
            title: 'Current Ambient Light Level',
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
            title: 'Current Horizontal Tilt Angle',
            type: 'integer',
            unit: 'arcdegrees',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Current Position',
            type: 'integer',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Current Vertical Tilt Angle',
            type: 'integer',
            unit: 'arcdegrees',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Hold Position',
            type: 'boolean',
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.leak-detected': {
        HomeKitDevice.addCapability(device, 'LeakSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'LeakProperty',
            title: 'Leak Detected',
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
            title: 'Occupancy Detected',
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
            title: 'Position State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Last Position State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );

        HomeKitDevice.addCapability(device, 'PushButton');

        device.addEvent('pressed', {
          '@type': 'PressedEvent',
        });
        device.addEvent('doublePressed', {
          '@type': 'DoublePressedEvent',
        });
        device.addEvent('longPressed', {
          '@type': 'LongPressedEvent',
        });
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
            title: 'Status Active',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.smoke-detected': {
        HomeKitDevice.addCapability(device, 'SmokeSensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'SmokeProperty',
            title: 'Smoke Detected',
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
            title: 'Status Fault',
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
            title: 'Status Jammed',
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
            title: 'Status Low Battery',
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
            title: 'Status Tampered',
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
            title: 'Target Horizontal Tilt Angle',
            type: 'integer',
            unit: 'arcdegrees',
            minimum,
            maximum,
            multipleOf: 0.1,
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
            title: 'Target Position',
            type: 'integer',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Target Vertical Tilt Angle',
            type: 'integer',
            unit: 'arcdegrees',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Security System Alarm Type',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Charging State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.carbon-monoxide.level': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 100);

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'ConcentrationProperty',
            title: 'Carbon Monoxide Level',
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

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'ConcentrationProperty',
            title: 'Carbon Monoxide Peak Level',
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
            title: 'Carbon Dioxide Detected',
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

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'ConcentrationProperty',
            title: 'Carbon Dioxide Level',
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

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'ConcentrationProperty',
            title: 'Carbon Dioxide Peak Level',
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
            title: 'Air Quality',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Lock Physical Controls',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Target Air Purifier State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
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
            title: 'Current Air Purifier State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Current Slat State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Filter Life Level',
            type: 'number',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Filter Change Needed',
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
            title: 'Reset Filter Indication',
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
            title: 'Current Fan State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Active',
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
            title: 'Swing Enabled',
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
            title: 'Target Fan State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
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
            title: 'Target Fan State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
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
            title: 'Current Tilt Angle',
            type: 'integer',
            unit: 'arcdegrees',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Target Tilt Angle',
            type: 'integer',
            unit: 'arcdegrees',
            minimum,
            maximum,
            multipleOf: 1,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.density.ozone': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 1000);

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'DensityProperty',
            title: 'Ozone Density',
            type: 'number',
            unit: 'micrograms per cubic meter',
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

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'DensityProperty',
            title: 'Nitrogen Dioxide Density',
            type: 'number',
            unit: 'micrograms per cubic meter',
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

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'DensityProperty',
            title: 'Sulphur Dioxide Density',
            type: 'number',
            unit: 'micrograms per cubic meter',
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

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'DensityProperty',
            title: 'PM2.5 Density',
            type: 'number',
            unit: 'micrograms per cubic meter',
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

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'DensityProperty',
            title: 'PM10 Density',
            type: 'number',
            unit: 'micrograms per cubic meter',
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

        HomeKitDevice.addCapability(device, 'AirQualitySensor');
        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            '@type': 'DensityProperty',
            title: 'VOC Density',
            type: 'number',
            unit: 'micrograms per cubic meter',
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
            title: 'Color Temperature',
            type: 'integer',
            unit: 'kelvin',
            minimum,
            maximum,
          },
          characteristic.value,
          (value) => Math.round(1e6 / value),
          (value) => Math.round(1e6 / value)
        );
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
            title: 'Supported RTP Configuration',
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
            title: 'Volume',
            type: 'integer',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
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
            title: 'Mute',
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
            title: 'Night Vision',
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
          title: 'Optical Zoom',
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
          title: 'Digital Zoom',
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
            title: 'Image Rotation',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
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
            title: 'Image Mirroring',
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
            title: 'Streaming Status',
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
      case 'public.hap.characteristic.in-use': {
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
            title: 'In Use',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.is-configured': {
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
            title: 'Is Configured',
            type: 'boolean',
            readOnly: true,
          },
          characteristic.value,
          (value) => value !== 0
        );
        break;
      }
      case 'public.hap.characteristic.humidifier-dehumidifier.state.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Inactive',
          1: 'Idle',
          2: 'Humidifying',
          3: 'Dehumidifying',
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
            title: 'Current Humidifier/Dehumidifier State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.heater-cooler.state.current': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Inactive',
          1: 'Idle',
          2: 'Heating',
          3: 'Cooling',
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
            title: 'Current Heater/Cooler State',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.heater-cooler.state.target': {
        // The information for this characteristic is currently missing from
        // the spec...
        break;
      }
      case 'public.hap.characteristic.program-mode': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'No Programs Scheduled',
          1: 'Program Scheduled',
          2: 'Program Scheduled, currently overridden to manual mode',
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
            title: 'Program Mode',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );
        break;
      }
      // eslint-disable-next-line max-len
      case 'public.hap.characteristic.relative-humidity.dehumidifier-threshold': {
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
            title: 'Relative Humidity Dehumidifier Threshold',
            type: 'integer',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.relative-humidity.humidifier-threshold': {
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
            title: 'Relative Humidity Humidifier Threshold',
            type: 'integer',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.set-duration': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 3600);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            title: 'Set Duration',
            type: 'integer',
            unit: 'second',
            minimum,
            maximum,
            multipleOf: 1,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.remaining-duration': {
        const minimum = HomeKitDevice.adjustMinimum(characteristic, 0);
        const maximum = HomeKitDevice.adjustMaximum(characteristic, 3600);

        property = new HomeKitProperty(
          device,
          name,
          aid,
          service.type,
          characteristic.type,
          characteristic.iid,
          characteristic.format,
          {
            title: 'Remaining Duration',
            type: 'integer',
            unit: 'second',
            minimum,
            maximum,
            multipleOf: 1,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      case 'public.hap.characteristic.humidifier-dehumidifier.state.target': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Humidifier or Dehumidifier',
          1: 'Humidifier',
          2: 'Dehumidifier',
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
            title: 'Target Humidifier/Dehumidifier State',
            type: 'string',
            enum: Object.values(values),
          },
          characteristic.value,
          PropertyUtils.buildEnumGetter(values),
          PropertyUtils.buildEnumSetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.valve-type': {
        const values = HomeKitDevice.filterEnumValues({
          0: 'Generic valve',
          1: 'Irrigation',
          2: 'Shower head',
          3: 'Water faucet',
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
            title: 'Valve Type',
            type: 'string',
            enum: Object.values(values),
            readOnly: true,
          },
          characteristic.value,
          characteristic.value,
          PropertyUtils.buildEnumGetter(values)
        );
        break;
      }
      case 'public.hap.characteristic.water-level': {
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
            title: 'Water Level',
            type: 'integer',
            unit: 'percent',
            minimum,
            maximum,
            multipleOf: 1,
            readOnly: true,
          },
          characteristic.value
        );
        break;
      }
      default: {
        const c = VendorExtensions.CharacteristicMapByUuid[characteristic.type];
        if (c && c.property) {
          const meta = c.property.meta;

          if (characteristic.hasOwnProperty('minValue')) {
            meta.minimum = characteristic.minValue;
          } else if (!meta.hasOwnProperty('minimum') &&
                     ['uint8', 'uint16', 'uint32', 'uint64', 'int'].includes(
                       characteristic.format)) {
            switch (characteristic.format) {
              case 'uint8':
              case 'uint16':
              case 'uint32':
              case 'uint64':
                meta.minimum = 0;
                break;
              case 'int':
                meta.minimum = -0x80000000;
                break;
            }
          }

          if (characteristic.hasOwnProperty('maxValue')) {
            meta.maximum = characteristic.maxValue;
          } else if (!meta.hasOwnProperty('maximum') &&
                     ['uint8', 'uint16', 'uint32', 'uint64', 'int'].includes(
                       characteristic.format)) {
            switch (characteristic.format) {
              case 'uint8':
                meta.maximum = 0xFF;
                break;
              case 'uint16':
                meta.maximum = 0xFFFF;
                break;
              case 'uint32':
                meta.maximum = 0xFFFFFFFF;
                break;
              case 'uint64':
                meta.maximum = 0xFFFFFFFFFFFFFFFF;
                break;
              case 'int':
                meta.maximum = 0x7FFFFFFF;
                break;
            }
          }

          if (!meta.hasOwnProperty('multipleOf')) {
            if (characteristic.hasOwnProperty('minStep')) {
              meta.multipleOf = characteristic.minStep;
            } else {
              switch (characteristic.format) {
                case 'uint8':
                case 'uint16':
                case 'uint32':
                case 'uint64':
                  meta.multipleOf = 1;
                  break;
              }
            }
          }

          if (!characteristic.perms.includes('tw') &&
              !characteristic.perms.includes('pw')) {
            meta.readOnly = true;
          }

          property = new HomeKitProperty(
            device,
            name,
            aid,
            service.type,
            characteristic.type,
            characteristic.iid,
            characteristic.format,
            meta,
            characteristic.value,
            c.property.getter,
            c.property.setter
          );
        }

        if (c && c.action) {
          device.addAction(
            c.action.name,
            c.action.meta
          );
          this.actionCallbacks.set(c.action.name, c.action.callback);
        }

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
   * Attempt to pair with the device.
   *
   * @param {string} pin - PIN to use for pairing
   * @returns {Promise} Promise which resolves when pairing is complete.
   */
  pair(pin) {
    const fn = () => {
      let client;
      if (this.pendingPairingData && this.pendingPairingClient &&
          pin !== '000-00-000') {
        client = this.pendingPairingClient;
      } else {
        client = HomeKitDevice.getClientFromService(
          this.service,
          this.connectionType
        );
      }

      // special case where the PIN will be displayed to the user on-screen
      if (pin === '000-00-000') {
        return client.startPairing().then((data) => {
          this.pendingPairingData = data;
          this.pendingPairingClient = client;
          throw new Error('Enter new PIN from device\'s display');
        });
      }

      let promise;
      if (this.pendingPairingData) {
        promise = client.finishPairing(this.pendingPairingData, pin);
      } else {
        promise = client.pairSetup(pin);
      }

      return promise.then(() => {
        this.pendingPairingData = null;
        this.pendingPairingClient = null;

        return this.adapter.db.storePairingData(
          this.deviceID,
          client.getLongTermData()
        );
      }).then(() => {
        this.client = client;
        this.paired = true;
        this.pinRequired = false;
        return this.addDevicesAndProperties(SKIP_QUEUE);
      }).then(() => {
        if (this.watching) {
          return Promise.resolve();
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

        console.log(`Pairing failed for device ${this.deviceID}: ${e}`);
        return Promise.reject(e);
      });
    };

    if (this.connectionType === 'ble') {
      return this.adapter.queueBLEOperation(fn);
    }

    return fn();
  }

  /**
   * Unpair from the device.
   *
   * @returns {Promise} Promise which resolves when the device is unpaired.
   */
  unpair() {
    const fn = () => {
      let promise;
      if (this._connection && this._subscribed) {
        promise = this.client.unsubscribeCharacteristics(
          this._subscribed,
          this._connection
        ).catch(() => {});
      } else {
        promise = Promise.resolve();
      }

      return promise.then(() => {
        if (this.connectionType === 'ip') {
          this.client.removeAllListeners('event');
          this.client.removeAllListeners('disconnect');
        }

        return this.client.removePairing(
          this.client.pairingProtocol.iOSDevicePairingID
        );
      }).catch((e) => {
        console.log(`Unpairing failed for device ${this.deviceID}: ${e}`);
      });
    };

    if (this.connectionType === 'ble') {
      return this.adapter.queueBLEOperation(fn);
    }

    return fn();
  }

  /**
   * Trigger a property update.
   *
   * @param {number} gsn - New GSN
   */
  triggerBLEUpdate(gsn) {
    this.gsn = gsn;

    const now = new Date();
    if (this.lastRead && now - this.lastRead <= 500) {
      // If it's been less than 500 ms since our last read completed, just
      // skip this.
      return;
    }

    console.debug(`Update triggered for: ${this.deviceID}`);
    this.readBLECharacteristics(TRIGGERED_BY_EVENT);
  }

  /**
   * Read all BLE characteristics that are mapped to properties.
   *
   * @param {boolean} triggeredByEvent - whether or not this read was triggered
   *                  by an event
   * @returns {Promise} Promise which resolves when the process has completed.
   */
  readBLECharacteristics(triggeredByEvent = false) {
    if (this.readPromise) {
      return this.readPromise;
    }

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

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

    this.readPromise = this.adapter.queueBLEOperation(() => {
      return this.client.getCharacteristics(characteristics)
        .then((result) => {
          this.handleCharacteristicEvent(result, triggeredByEvent);
        })
        .catch((e) => {
          console.log(
            `Error reading characteristics for device ${this.deviceID}: ${e}`
          );
        })
        .then(() => {
          this.readPromise = null;
          this.lastRead = new Date();
          this.pollTimeout = setTimeout(this.readBLECharacteristics.bind(this),
                                        BLE_POLL_INTERVAL);
        });
    });

    return this.readPromise;
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

        return this.client.subscribeCharacteristics(characteristics)
          .then((conn) => {
            this._subscribed = characteristics;
            this._connection = conn;
          });
      }
      case 'ble': {
        // With BLE devices, we poll, rather than subscribing, for 3 reasons:
        // 1. Bluetooth adapters can only have a limited number of open
        //    connections.
        // 2. Keeping an active connection requires that you refresh the
        //    security session frequently, otherwise the connection will drop.
        // 3. We're also watching for disconnected events, which should be
        //    sufficient for time-critical properties.
        this.pollTimeout = setTimeout(this.readBLECharacteristics.bind(this),
                                      BLE_POLL_INTERVAL);
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
   * @param {boolean} triggeredByEvent - whether or not this read was triggered
   *                  by an event
   */
  handleCharacteristicEvent(event, triggeredByEvent = false) {
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

            if (triggeredByEvent && property.title === 'Last Position State') {
              switch (property.value) {
                case 'Single Press':
                  device.eventNotify(new Event(device, 'pressed'));
                  break;
                case 'Double Press':
                  device.eventNotify(new Event(device, 'doublePressed'));
                  break;
                case 'Long Press':
                  device.eventNotify(new Event(device, 'longPressed'));
                  break;
              }
            }
            break;
          }
        }
      }
    }
  }

  performAction(action) {
    action.start();

    switch (action.name) {
      case 'lock':
      case 'unlock': {
        for (const prop of this.properties.values()) {
          if (prop['@type'] === 'TargetLockedProperty') {
            if (action.name === 'lock') {
              prop.setValue('locked');
            } else {
              prop.setValue('unlocked');
            }
            break;
          }
        }
        break;
      }
      default:
        if (this.actionCallbacks.has(action.name)) {
          this.actionCallbacks.get(action.name)(this, action);
        } else {
          action.status = 'error';
          this.actionNotify(action);
          return Promise.resolve();
        }

        break;
    }

    action.finish();

    return Promise.resolve();
  }
}

module.exports = HomeKitDevice;
