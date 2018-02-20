"""HomeKit adapter for Mozilla IoT Gateway."""

from gateway_addon import Device
from hapclient import HapClient
import threading
import time

from .database import Database
from .homekit_property import HomeKitBulbProperty, HomeKitPlugProperty
from .util import hsv_to_rgb


_POLL_INTERVAL = 5


class HomeKitDevice(Device):
    """HomeKit device type."""

    def __init__(self, adapter, _id, dev):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        dev -- the device description object to initialize from
        """
        Device.__init__(self, adapter, _id)

        database = Database()
        if not database.open():
            raise ValueError('Failed to open settings database.')

        pairing_data = database.load_pairing_data(dev['id'])
        if pairing_data:
            self.client = HapClient(dev['id'],
                                    address=dev['address'],
                                    port=dev['port'],
                                    pairing_data=pairing_data)
        else:
            config = database.load_config()
            if dev['id'] in config['pinCodes']:
                self.client = HapClient(dev['id'],
                                        address=dev['address'],
                                        port=dev['port'])

                if not self.client.pair(config['pinCodes'][dev['id']]):
                    database.close()
                    raise ValueError('Invalid PIN')
                else:
                    database.store_pairing_data(dev['id'],
                                                self.client.pairing_data)
            else:
                database.close()
                raise ValueError('Unknown PIN')

        database.close()

        self.dev = dev
        self.description = dev['md']
        self.name = dev['name'].split('.')[0]

        t = threading.Thread(target=self.poll)
        t.daemon = True
        t.start()

    def poll(self):
        """Poll the device for changes."""
        while True:
            time.sleep(_POLL_INTERVAL)

            to_poll = ['{}.{}'.format(p.aid, p.iid)
                       for p in self.properties.values()
                       if p.aid is not None and p.iid is not None]

            characteristics = self.client.get_characteristics(to_poll)
            if not characteristics:
                continue

            for prop in self.properties.values():
                prop.update(characteristics['characteristics'])


class HomeKitPlug(HomeKitDevice):
    """HomeKit smart plug type."""

    def __init__(self, adapter, _id, dev):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        dev -- the device description object to initialize from
        """
        HomeKitDevice.__init__(self, adapter, _id, dev)

        self.type = 'onOffSwitch'

        accessories = self.client.get_accessories()
        if not accessories:
            self.client.unpair()
            raise ValueError('Failed to get accessory list')

        for acc in accessories['accessories']:
            aid = acc['aid']

            for svc in acc['services']:
                for char in svc['characteristics']:
                    iid = char['iid']

                    if svc['type'] == \
                            'public.hap.service.accessory-information' and \
                            char['type'] == 'public.hap.characteristic.name':
                        self.name = char['value']

                    elif svc['type'] in ['public.hap.service.outlet',
                                         'public.hap.service.switch'] and \
                            char['type'] == 'public.hap.characteristic.on':
                        self.properties['on'] = HomeKitPlugProperty(
                            self, aid, iid, 'on', {'type': 'boolean'},
                            char['value'])


class HomeKitBulb(HomeKitDevice):
    """HomeKit smart bulb type."""

    def __init__(self, adapter, _id, dev):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        dev -- the device description object to initialize from
        """
        HomeKitDevice.__init__(self, adapter, _id, dev)

        hue, saturation, brightness = None, None, None
        accessories = self.client.get_accessories()
        if not accessories:
            self.client.unpair()
            raise ValueError('Failed to get accessory list')

        for acc in accessories['accessories']:
            aid = acc['aid']

            for svc in acc['services']:
                for char in svc['characteristics']:
                    iid = char['iid']

                    if svc['type'] == \
                            'public.hap.service.accessory-information' and \
                            char['type'] == 'public.hap.characteristic.name':
                        self.name = char['value']

                    elif svc['type'] == 'public.hap.service.lightbulb':
                        if char['type'] == 'public.hap.characteristic.on':
                            self.properties['on'] = HomeKitBulbProperty(
                                self, aid, iid, 'on', {'type': 'boolean'},
                                char['value'])
                        elif char['type'] == 'public.hap.characteristic.hue':
                            self.properties['_hue'] = \
                                HomeKitBulbProperty(self,
                                                    aid,
                                                    iid,
                                                    '_hue',
                                                    {'type': 'number',
                                                     'unit': 'arcdegrees',
                                                     'min': 0,
                                                     'max': 360},
                                                    char['value'])
                            hue = char['value']
                        elif char['type'] == \
                                'public.hap.characteristic.saturation':
                            self.properties['_saturation'] = \
                                HomeKitBulbProperty(self,
                                                    aid,
                                                    iid,
                                                    '_saturation',
                                                    {'type': 'number',
                                                     'unit': 'percent',
                                                     'min': 0,
                                                     'max': 100},
                                                    char['value'])
                            saturation = char['value']
                        elif char['type'] == \
                                'public.hap.characteristic.brightness':
                            self.properties['level'] = \
                                HomeKitBulbProperty(self,
                                                    aid,
                                                    iid,
                                                    'level',
                                                    {'type': 'number',
                                                     'unit': 'percent',
                                                     'min': 0,
                                                     'max': 100},
                                                    char['value'])
                            brightness = char['value']

        if brightness is None:
            self.type = 'onOffLight'
        else:
            if hue is not None and saturation is not None:
                self.type = 'dimmableColorLight'

                self.properties['color'] = \
                    HomeKitBulbProperty(self,
                                        None,
                                        None,
                                        'color',
                                        {'type': 'string'},
                                        hsv_to_rgb(hue,
                                                   saturation,
                                                   brightness))
            else:
                self.type = 'dimmableLight'
