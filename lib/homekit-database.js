/**
 * Wrapper around the gateway's database.
 */
'use strict';

const {Database} = require('gateway-addon');
const fs = require('fs');
const mkdirp = require('mkdirp');
const os = require('os');
const path = require('path');
const storage = require('node-persist');

function getDataPath() {
  let profileDir;
  if (process.env.hasOwnProperty('MOZIOT_HOME')) {
    profileDir = process.env.MOZIOT_HOME;
  } else {
    profileDir = path.join(os.homedir(), '.mozilla-iot');
  }

  return path.join(profileDir, 'data', 'homekit-adapter');
}

/**
 * Wrapper around gateway's settings database.
 */
class HomeKitDatabase extends Database {
  /**
   * Open the database.
   *
   * @returns Promise which resolves when the database has been opened.
   */
  open() {
    const dataDir = getDataPath();
    if (!fs.existsSync(dataDir)) {
      mkdirp.sync(dataDir, {mode: 0o755});
    }

    return super.open()
      .then(() => storage.init({dir: dataDir}))
      .then(() => this.migrate());
  }

  /**
   * Migrate data from the gateway's database into node-persist.
   */
  migrate() {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject('Database not open');
        return;
      }

      const key = 'addons.homekit-adapter.pairing-data.%';
      this.conn.all(
        'SELECT key, value FROM settings WHERE key LIKE ?',
        [key],
        (error, rows) => {
          if (error) {
            reject(error);
            return;
          }

          const promises = [];
          for (const row of rows) {
            const newKey = row.key.split('.').slice(2).join('.');
            promises.push(
              storage.setItem(newKey, row.value).then(() => {
                return new Promise((res, rej) => {
                  this.conn.run(
                    'DELETE FROM settings WHERE key = ?',
                    [row.key],
                    (error) => {
                      if (error) {
                        rej(error);
                      } else {
                        res();
                      }
                    }
                  );
                });
              })
            );
          }

          Promise.all(promises).then(() => resolve());
        }
      );
    });
  }

  /**
   * Store pairing data in the database.
   *
   * @param {string} id - Device ID
   * @param {Object} data - Pairing data
   * @returns {Promise} Promise which resolves when the operation completes.
   */
  storePairingData(id, data) {
    const key = `pairing-data.${id}`;
    return storage.setItem(key, data);
  }

  /**
   * Load pairing data from the database.
   *
   * @param {string} id - Device ID
   * @returns {Promise} Promise which resolves to the pairing data, if found.
   */
  loadPairingData(id) {
    const key = `pairing-data.${id}`;
    return storage.getItem(key);
  }

  /**
   * Delete pairing data from the database.
   *
   * @param {string} id - Device ID
   * @returns {Promise} Promise which resolves when the operation completes.
   */
  removePairingData(id) {
    const key = `pairing-data.${id}`;
    return storage.removeItem(key);
  }
}

module.exports = HomeKitDatabase;
