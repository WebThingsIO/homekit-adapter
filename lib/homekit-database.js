/**
 * Wrapper around the gateway's database.
 */
'use strict';

const {Database} = require('gateway-addon');

/**
 * Wrapper around gateway's settings database.
 */
class HomeKitDatabase extends Database {
  /**
   * Store pairing data in the database.
   *
   * @param {string} id - Device ID
   * @param {Object} data - Pairing data
   * @returns {Promise} Promise which resolves when the operation completes.
   */
  storePairingData(id, data) {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject('Database not open');
        return;
      }

      const key = `addons.${this.packageName}.pairing-data.${id}`;
      this.conn.run(
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        [key, JSON.stringify(data)],
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  }

  /**
   * Load pairing data from the database.
   *
   * @param {string} id - Device ID
   * @returns {Promise} Promise which resolves to the pairing data, if found.
   */
  loadPairingData(id) {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject('Database not open');
        return;
      }

      const key = `addons.${this.packageName}.pairing-data.${id}`;
      this.conn.get(
        'SELECT value FROM settings WHERE key = ?',
        [key],
        (error, row) => {
          if (error) {
            reject(error);
          } else if (!row) {
            reject('Key not found');
          } else {
            const data = JSON.parse(row.value);

            // Handle legacy config entries
            if (data.hasOwnProperty('iOSPairingID')) {
              data.iOSDevicePairingID = data.iOSPairingID;
              delete data.iOSPairingID;
            }

            resolve(data);
          }
        }
      );
    });
  }

  /**
   * Delete pairing data from the database.
   *
   * @param {string} id - Device ID
   * @returns {Promise} Promise which resolves when the operation completes.
   */
  removePairingData(id) {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject('Database not open');
        return;
      }

      const key = `addons.${this.packageName}.pairing-data.${id}`;
      this.conn.run(
        'DELETE FROM settings WHERE key = ?',
        [key],
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  }
}

module.exports = HomeKitDatabase;
