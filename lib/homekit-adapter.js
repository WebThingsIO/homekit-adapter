/**
 * HomeKit adapter for Mozilla IoT Gateway.
 */
'use strict';

const {Adapter} = require('gateway-addon');
const {BLEDiscovery, IPDiscovery} = require('hap-controller');
const HomeKitDatabase = require('./homekit-database');
const HomeKitDevice = require('./homekit-device');
const noble = require('noble');

/**
 * Adapter for HomeKit devices.
 */
class HomeKitAdapter extends Adapter {
  /**
   * Initialize the object.
   *
   * @param {Object} addonManager - AddonManagerProxy object
   * @param {Object} manifest - Package manifest
   */
  constructor(addonManager, manifest) {
    super(addonManager, manifest.name, manifest.name);
    addonManager.addAdapter(this);

    this.knownDevices = new Set();

    this.startIPDiscovery();
    this.startBLEDiscovery();

    noble.on('warning', (e) => console.warn('noble warning:', e));
  }

  /**
   * Set the PIN for the given device.
   *
   * @param {string} deviceId - ID of device
   * @param {string} pin - PIN to set
   * @returns {Promise} Promise which resolves when the PIN has been set.
   */
  setPin(deviceId, pin) {
    const device = this.getDevice(deviceId);
    if (!device) {
      return Promise.reject('Device not found');
    }

    if (device.paired) {
      return Promise.reject('Device already paired');
    }

    return device.pair(pin);
  }

  /**
   * Unpair a device with the adapter.
   *
   * @param {Object} device - Device to unpair
   * @returns {Promise} Promise which resolves to the device removed.
   */
  removeThing(device) {
    let promise;

    if (device.paired) {
      if (device.bridge) {
        device.bridge.removeDevice(device);
        promise = Promise.resolve();
      } else {
        const database = new HomeKitDatabase(this.packageName);
        promise = device.unpair().then(() => {
          return database.open();
        }).then(() => {
          return database.removePairingData(device.deviceID);
        }).then(() => {
          database.close();
        });
      }
    } else {
      promise = Promise.resolve();
    }

    return promise.then(() => {
      this.knownDevices.delete(device.deviceID);
      this.handleDeviceRemoved(device);
    });
  }

  /**
   * Add a discovered IP device.
   *
   * @param {Object} service - The mDNS service record
   */
  addIPDevice(service) {
    const id = HomeKitDevice.getIdFromService(service, 'ip');

    if (!this.knownDevices.has(id)) {
      this.knownDevices.add(id);

      const device = new HomeKitDevice(this, 'ip', service);
      device.promise.then(() => {
        this.handleDeviceAdded(device);
      });
    }
  }

  /**
   * Add a discovered BLE device.
   *
   * @param {Object} service - The BLE advertisement data
   */
  addBLEDevice(service) {
    const id = HomeKitDevice.getIdFromService(service, 'ble');

    if (!this.knownDevices.has(id)) {
      this.knownDevices.add(id);

      const device = new HomeKitDevice(this, 'ble', service);
      device.promise.then(() => {
        this.handleDeviceAdded(device);
      });
    } else {
      // There is a period of time where the device object is being built but
      // is not yet in the devices map.
      const device = this.devices[`homekit-${id}`];
      if (device && device.gsn !== service.GSN) {
        device.triggerBLEUpdate(service.GSN);
      }
    }
  }

  /**
   * Start searching for IP devices.
   */
  startIPDiscovery() {
    this.ipDiscovery = new IPDiscovery();
    this.ipDiscovery.on('serviceUp', (service) => {
      console.debug('Found IP device:', service);
      if (service.pv && service.pv.split('.')[0] !== '1') {
        console.info(`Not adding device. PV=${service.pv}`);
        return;
      }

      this.addIPDevice(service);
    });
    this.ipDiscovery.start();
  }

  /**
   * Start searching for BLE devices.
   */
  startBLEDiscovery() {
    this.bleDiscovery = new BLEDiscovery();
    this.bleDiscovery.on('serviceUp', (service) => {
      const partial = {
        CoID: service.CoID,
        TY: service.TY,
        AIL: service.AIL,
        SF: service.SF,
        DeviceID: service.DeviceID,
        ACID: service.ACID,
        GSN: service.GSN,
        CN: service.CN,
        CV: service.CV,
      };

      console.debug('Found BLE device:', partial);
      if (service.CV !== 2) {
        console.info(`Not adding device. CV=${service.CV}`);
        return;
      }

      this.addBLEDevice(service);
    });
    this.bleDiscovery.start(true);
  }

  /**
   * Clean up before shutting down this adapter.
   *
   * @returns {Promise} Promise which resolves when finished unloading.
   */
  unload() {
    if (this.ipDiscovery) {
      this.ipDiscovery.stop();
    }

    if (this.bleDiscovery) {
      this.bleDiscovery.stop();
    }

    return super.unload();
  }
}

module.exports = HomeKitAdapter;
