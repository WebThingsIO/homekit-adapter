"""Wrapper around the gateway's database."""

import json
import os
import sqlite3


_DB_PATHS = [
    os.path.join(os.path.expanduser('~'),
                 'mozilla-iot',
                 'gateway',
                 'db.sqlite3'),
    os.path.join(os.path.expanduser('~'),
                 '.mozilla-iot',
                 'config',
                 'db.sqlite3'),
]

if 'MOZIOT_HOME' in os.environ:
    _DB_PATHS.append(
        os.path.join(os.environ['MOZIOT_HOME'], 'config', 'db.sqlite3'))


class Database:
    """Wrapper around gateway's settings database."""

    def __init__(self):
        """Initialize the object."""
        self.path = None
        self.conn = None

        for p in _DB_PATHS:
            if os.path.isfile(p):
                self.path = p
                break

    def open(self):
        """Open the database."""
        if self.path is None:
            return False

        self.conn = sqlite3.connect(self.path)
        return True

    def close(self):
        """Close the database."""
        self.conn.close()

    def load_config(self):
        """Load the adapter's config from the database."""
        c = self.conn.cursor()
        c.execute(
            'SELECT value FROM settings WHERE key = "addons.homekit-adapter"')
        data = c.fetchone()
        c.close()

        if not data:
            return None

        data = json.loads(data[0])
        return data['moziot']['config']

    def store_pairing_data(self, id_, data):
        """
        Store pairing data in the database.

        id_ -- device ID
        data -- pairing data
        """
        key = 'addons.homekit-adapter.pairing-data.{}'.format(id_)
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
        key = 'addons.homekit-adapter.pairing-data.{}'.format(id_)
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
        key = 'addons.homekit-adapter.pairing-data.{}'.format(id_)
        c = self.conn.cursor()
        c.execute('DELETE FROM settings WHERE key = ?', (key,))
        self.conn.commit()
        c.close()
