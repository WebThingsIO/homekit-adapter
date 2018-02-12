/**
 *
 * HomeKitAdapter - an adapter for controlling HomeKit devices.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const HapClient = require('hap-client').default;
const Observable = require('rxjs/Observable').Observable;
const bonjour = require('bonjour')();
const Adapter = require('../adapter');
const Device = require('../device');
const Property = require('../property');
//var storage = require('node-persist');

const THING_TYPE_ON_OFF_COLOR_LIGHT = 'onOffColorLight';
const THING_TYPE_ON_OFF_LIGHT = 'onOffLight';
const THING_TYPE_DIMMABLE_LIGHT = 'dimmableLight';

/**
 * Property of a device.
 */
class HomeKitProperty extends Property {
  constructor(device, name, descr, value) {
    super(device, name, descr);
    this.setCachedValue(value);
  }

  /**
   * @param {boolean|number} value
   * @return {Promise} a promise which resolves to the updated value.
   */
  setValue(value) {
    let changed = this.value !== value;
    return new Promise(resolve => {
      this.setCachedValue(value);
      resolve(this.value);
      if (changed) {
        this.device.notifyPropertyChanged(this);
      }
    });
  }
}

/**
 * A HomeKit device.
 */
class HomeKitDevice extends Device {
  /**
   * @param {HomeKitAdapter} adapter
   * @param {Object} service The service object from bonjour.find()
   * @param {String} pin PIN code for device
   */
  constructor(adapter, service, pin) {
    const id = `homekit-${service.txt.id}`;
    super(adapter, id);

    // Set the generic, discovered name for now.
    this.name = service.name;
    this.description = service.name;
    this.addr = service.addresses[0];
    this.port = service.port;
    this.client = new HapClient('Mozilla IoT Gateway', this.addr, this.port);
    this.client
      .pair(Observable.of(pin))  // TODO: this is failing
      .subscribe({
        complete() {
          console.log('Pairing complete');
          this.client.listAccessories().subscribe((data) => console.log(data));
        }
      });

    // TODO: set proper type and properties.
    this.type = THING_TYPE_ON_OFF_LIGHT;
    this.adapter.handleDeviceAdded(this);
  }
}

/**
 * HomeKit Adapter
 */
class HomeKitAdapter extends Adapter {
  constructor(addonManager, manifest) {
    super(addonManager, 'homekit-', manifest.name);

    addonManager.addAdapter(this);
  }

  startPairing(_timeoutSeconds) {
  }

  cancelPairing() {
  }
}

/**
 * Search for devices using mDNS.
 */
function loadHomeKitAdapter(addonManager, manifest) {
  const adapter = new HomeKitAdapter(addonManager, manifest);

  bonjour.find({type: 'hap', protocol: 'tcp'}, (service) => {
    if (manifest.moziot.config.pinCodes.hasOwnProperty(service.txt.id)) {
      const pin = manifest.moziot.config.pinCodes[service.txt.id];
      new HomeKitDevice(adapter, service, pin);
    } else {
      console.log(`PIN not set for device with id ${service.txt.id}`);
    }
  });
}

module.exports = loadHomeKitAdapter;
