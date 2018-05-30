"""HomeKit adapter for Mozilla IoT Gateway."""

from gateway_addon import Device
from hapclient import HapClient
import threading
import time

from .homekit_database import HomeKitDatabase
from .homekit_errors import DatabaseError, HapError, PairingError
from .homekit_property import HomeKitBulbProperty, HomeKitPlugProperty
from .util import hsv_to_rgb


_POLL_INTERVAL = 5


class HomeKitDevice(Device):
    """HomeKit device type."""

    def __init__(self, adapter, _id, dev, bridge=None):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        dev -- the device description object to initialize from
        bridge -- HomeKitBridge object, if attached to one
        """
        Device.__init__(self, adapter, _id)

        self.dev = dev

        if 'md' in dev and dev['md']:
            self.description = dev['md']
        else:
            self.description = _id

        if 'name' in dev and dev['name']:
            self.name = dev['name'].replace('._hap._tcp.local.', '')
        else:
            self.name = _id

        self.bridge = bridge

        if bridge is not None:
            return

        database = HomeKitDatabase(adapter.package_name)
        if not database.open():
            raise DatabaseError('Failed to open settings database.')

        pairing_data = database.load_pairing_data(dev['id'])
        if pairing_data:
            self.client = HapClient(dev['id'],
                                    address=dev['address'],
                                    port=dev['port'],
                                    pairing_data=pairing_data)
        else:
            config = database.load_config()
            found = False
            for item in config['pinCodes']:
                if item['id'] == dev['id']:
                    found = True

                    # If the PIN wasn't set, let's just bail here.
                    if 'pin' not in item or not item['pin']:
                        database.close()
                        raise PairingError(PairingError.UNKNOWN_PIN)

                    self.client = HapClient(dev['id'],
                                            address=dev['address'],
                                            port=dev['port'])

                    if not self.client.pair(item['pin']):
                        database.close()
                        raise PairingError(PairingError.INVALID_PIN)

                    database.store_pairing_data(dev['id'],
                                                self.client.pairing_data)

            # If this PIN wasn't found in the database, add a stub for the user
            # to configure.
            if not found:
                config['pinCodes'].append({
                    'id': dev['id'],
                    'pin': '',
                    'note': '{} ({})'.format(self.name, dev['md']),
                })

                database.save_config(config)
                database.close()
                raise PairingError(PairingError.UNKNOWN_PIN)

        database.close()

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

    def __init__(self, adapter, _id, dev, bridge=None, accessories=None):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        dev -- the device description object to initialize from
        bridge -- HomeKitBridge object, if attached to one
        accessories -- optional list of accessories to initialize from
        """
        HomeKitDevice.__init__(self, adapter, _id, dev, bridge=bridge)

        self.type = 'onOffSwitch'

        if bridge is None and not accessories:
            accessories = self.client.get_accessories()

        if not accessories:
            if bridge is None:
                self.client.unpair()

            raise HapError('Failed to get accessory list')

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

    def __init__(self, adapter, _id, dev, bridge=None, accessories=None):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        dev -- the device description object to initialize from
        bridge -- HomeKitBridge object, if attached to one
        accessories -- optional list of accessories to initialize from
        """
        HomeKitDevice.__init__(self, adapter, _id, dev, bridge=bridge)

        hue, saturation, brightness = None, None, None

        if bridge is None and not accessories:
            accessories = self.client.get_accessories()

        if not accessories:
            if bridge is None:
                self.client.unpair()

            raise HapError('Failed to get accessory list')

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
        elif hue is not None and saturation is not None:
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


class HomeKitBridge(HomeKitDevice):
    """HomeKit smart plug type."""

    def __init__(self, adapter, _id, dev):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        dev -- the device description object to initialize from
        """
        HomeKitDevice.__init__(self, adapter, _id, dev)

        self.type = 'bridge'
        self.devices = {}

        self.find_new_devices()

    def remove_device(self, _id):
        """
        Remove a device from this bridge.

        _id -- ID of device to remove
        """
        if _id in self.devices:
            del self.devices[_id]

    def find_new_devices(self):
        """Find any new devices attached to this bridge."""
        accessories = self.client.get_accessories()
        if not accessories:
            self.client.unpair()
            raise HapError('Failed to get accessory list')

        for acc in accessories['accessories']:
            aid = acc['aid']
            _id = '{}-{}'.format(self.id, aid)
            if _id in self.devices:
                continue

            name = None
            model = None
            device = None

            for svc in acc['services']:
                for char in svc['characteristics']:
                    try:
                        if svc['type'] == \
                                'public.hap.service.accessory-information':
                            if char['type'] == \
                                    'public.hap.characteristic.name':
                                name = char['value']
                            elif char['type'] == \
                                    'public.hap.characteristic.model':
                                model = char['value']
                        elif svc['type'] in ['public.hap.service.outlet',
                                             'public.hap.service.switch']:
                            if device:
                                continue

                            device = HomeKitPlug(self.adapter,
                                                 _id,
                                                 {'md': model, 'name': name},
                                                 bridge=self,
                                                 accessories={
                                                    'accessories': [acc],
                                                 })
                        elif svc['type'] == 'public.hap.service.lightbulb':
                            if device:
                                continue

                            device = HomeKitBulb(self.adapter,
                                                 _id,
                                                 {'md': model, 'name': name},
                                                 bridge=self,
                                                 accessories={
                                                    'accessories': [acc],
                                                 })
                        else:
                            continue
                    except PairingError as e:
                        # This should _never_ happen, as pairing is performed
                        # with the bridge, not individual devices, and that
                        # should already be done at this point.
                        print('Failed to pair with device {}: {}'
                              .format(_id, e))
                        continue
                    except HapError as e:
                        print('Error communicating with device {}: {}'
                              .format(_id, e))
                        continue
                    except DatabaseError as e:
                        print('Database error: {}'.format(e))
                        raise

            if device is not None:
                self.adapter.handle_device_added(device)
                self.devices[aid] = device

    def poll(self):
        """Poll the device for changes."""
        while True:
            time.sleep(_POLL_INTERVAL)

            accessories = self.client.get_accessories()
            for acc in accessories['accessories']:
                aid = acc['aid']
                if aid not in self.devices:
                    continue

                device = self.devices[aid]
                characteristics = []

                to_poll = ['{}.{}'.format(p.aid, p.iid)
                           for p in device.properties.values()
                           if p.aid is not None and p.iid is not None]

                for svc in acc['services']:
                    for char in svc['characteristics']:
                        iid = char['iid']
                        if '{}.{}'.format(aid, iid) in to_poll:
                            characteristics.append({
                                'aid': aid,
                                'iid': iid,
                                'value': char['value'],
                            })

                for prop in device.properties.values():
                    prop.update(characteristics)


class HomeKitUnpairedDevice(Device):
    """HomeKit unpaired device type stub."""

    def __init__(self, adapter, _id, dev):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        dev -- the device description object to initialize from
        """
        Device.__init__(self, adapter, _id)

        self.type = 'thing'
        self.pin_required = True
        self.pin_pattern = r'^\d{3}-\d{2}-\d{3}$'
        self.dev = dev

        if 'md' in dev and dev['md']:
            self.description = dev['md']
        else:
            self.description = _id

        if 'name' in dev and dev['name']:
            self.name = dev['name'].replace('._hap._tcp.local.', '')
        else:
            self.name = _id

    def pair(self, pin):
        """
        Attempt to pair with the device.

        pin -- PIN to use for pairing
        """
        database = HomeKitDatabase(self.adapter.package_name)
        if not database.open():
            raise DatabaseError('Failed to open settings database.')

        client = HapClient(self.dev['id'],
                           address=self.dev['address'],
                           port=self.dev['port'])

        if not client.pair(pin):
            database.close()
            raise PairingError(PairingError.INVALID_PIN)

        database.store_pairing_data(self.dev['id'],
                                    client.pairing_data)

        database.close()
