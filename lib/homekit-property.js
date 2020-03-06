/**
 * HomeKit property type.
 */
'use strict';

const {GattUtils} = require('hap-controller');
const {Property} = require('gateway-addon');

/**
 * HomeKit property type.
 */
class HomeKitProperty extends Property {
  /**
   * Initialize the object.
   *
   * @param {Object} device - Device this property belongs to
   * @param {string} name - Name of the property
   * @param {number} aid - Accessory ID
   * @param {string} serviceType - Service UUID
   * @param {string} characteristicType - Characteristic UUID
   * @param {number} iid - Instance ID
   * @param {string} hapFormat - HAP format
   * @param {Object} description - Description of the property
   * @param {*} value - Current value of this property
   * @param {function?} fromHap - Function to call to transform received value
   * @param {function?} toHap - Function to call to transform new value
   */
  constructor(device, name, aid, serviceType, characteristicType, iid,
              hapFormat, description, value, fromHap = null, toHap = null) {
    super(device, name, description);
    this.aid = aid;
    this.iid = iid;
    this.serviceType = serviceType;
    this.characteristicType = characteristicType;
    this.hapFormat = hapFormat;
    this.fromHap = fromHap;
    this.toHap = toHap;
    this.metaProperty = false;
    this.postUpdate = false;

    this.setCachedValue(value);
  }

  /**
   * Set the current property value, making adjustments as necessary.
   *
   * @param {*} value - New value
   */
  setCachedValue(value) {
    if (this.fromHap && typeof value !== 'undefined') {
      value = this.fromHap(value);
    }

    this.value = value;

    if (this.postUpdate) {
      this.postUpdate(value);
    }
  }

  /**
   * Set the new value of the property.
   *
   * @param {*} value - New value
   * @returns {Promise} Promise which resolves when the value has been set.
   */
  setValue(value) {
    if (this.readOnly) {
      return Promise.reject('Read-only property');
    }

    if (this.hasOwnProperty('minimum')) {
      value = Math.max(this.minimum, value);
    }

    if (this.hasOwnProperty('maximum')) {
      value = Math.min(this.maximum, value);
    }

    if (this.hasOwnProperty('multipleOf')) {
      value = Math.round(value / this.multipleOf) * this.multipleOf;
    }

    if (this.type === 'integer') {
      value = Math.round(value);
    }

    if (this.toHap) {
      value = this.toHap(value);
    }

    if (!this.metaProperty) {
      let client, adapter;

      if (this.device.bridge === null) {
        client = this.device.client;
        adapter = this.device.adapter;
      } else {
        client = this.device.bridge.client;
        adapter = this.device.bridge.adapter;
      }

      switch (this.device.connectionType) {
        case 'ip':
          return client.setCharacteristics({
            [`${this.aid}.${this.iid}`]: value,
          }).then(() => {
            this.setCachedValue(value);
            this.device.notifyPropertyChanged(this);
          });
        case 'ble':
          return adapter.queueBLEOperation(() => {
            return client.setCharacteristics([
              {
                serviceUuid: this.serviceType,
                characteristicUuid: this.characteristicType,
                iid: this.iid,
                value: GattUtils.valueToBuffer(value, this.hapFormat),
              },
            ]).then(() => {
              this.setCachedValue(value);
              this.device.notifyPropertyChanged(this);
            });
          });
        default:
          throw new Error('Unknown connection type');
      }
    } else {
      this.setCachedValue(value);
      this.device.notifyPropertyChanged(this);
      return Promise.resolve();
    }
  }
}

module.exports = HomeKitProperty;
