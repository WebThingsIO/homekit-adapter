"""Wrapper around the gateway's database."""

from gateway_addon import Database
import json


class HomeKitDatabase(Database):
    """Wrapper around gateway's settings database."""

    def store_pairing_data(self, id_, data):
        """
        Store pairing data in the database.

        id_ -- device ID
        data -- pairing data
        """
        if not self.conn:
            return

        key = 'addons.{}.pairing-data.{}'.format(self.package_name, id_)
        c = self.conn.cursor()
        c.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                  (key, json.dumps(data)))
        self.conn.commit()
        c.close()

    def load_pairing_data(self, id_):
        """
        Load pairing data from the database.

        id_ -- device ID
        """
        if not self.conn:
            return None

        key = 'addons.{}.pairing-data.{}'.format(self.package_name, id_)
        c = self.conn.cursor()
        c.execute('SELECT value FROM settings WHERE key = ?', (key,))
        data = c.fetchone()
        c.close()

        if not data:
            return None

        return json.loads(data[0])

    def remove_pairing_data(self, id_):
        """
        Delete pairing data from the database.

        id_ -- device ID
        """
        if not self.conn:
            return

        key = 'addons.{}.pairing-data.{}'.format(self.package_name, id_)
        c = self.conn.cursor()
        c.execute('DELETE FROM settings WHERE key = ?', (key,))
        self.conn.commit()
        c.close()
