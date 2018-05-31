"""HomeKit adapter for Mozilla IoT Gateway."""

from gateway_addon import Adapter
from hapclient import HapClient

from .homekit_database import HomeKitDatabase
from .homekit_device import (HomeKitBridge, HomeKitBulb, HomeKitPlug,
                             HomeKitUnpairedDevice)
from .homekit_errors import DatabaseError, HapError, PairingError

try:
    from gateway_addon.errors import SetPinError
except ImportError:
    pass

_TIMEOUT = 3


class HomeKitAdapter(Adapter):
    """Adapter for HomeKit devices."""

    def __init__(self, verbose=False):
        """
        Initialize the object.

        config -- current user configuration
        verbose -- whether or not to enable verbose logging
        """
        self.name = self.__class__.__name__
        Adapter.__init__(self,
                         'homekit-adapter',
                         'homekit-adapter',
                         verbose=verbose)

        self.pairing = False
        self.start_pairing(_TIMEOUT)

    def start_pairing(self, timeout):
        """
        Start the pairing process.

        timeout -- Timeout in seconds at which to quit pairing
        """
        self.pairing = True
        for dev in HapClient.discover(timeout=min(timeout, _TIMEOUT)):
            if not self.pairing:
                break

            _id = 'homekit-' + dev['id']
            if _id not in self.devices:
                try:
                    if dev['ci'] in ['Outlet', 'Switch']:
                        device = HomeKitPlug(self, _id, dev)
                    elif dev['ci'] == 'Lightbulb':
                        device = HomeKitBulb(self, _id, dev)
                    elif dev['ci'] == 'Bridge':
                        device = HomeKitBridge(self, _id, dev)

                        # Don't call handle_device_added(), as we don't want
                        # the bridge itself reported to the gateway.
                        self.devices[device.id] = device
                        continue
                    else:
                        continue
                except PairingError as e:
                    print('Failed to pair with device {}: {}'
                          .format(dev['id'], e))

                    device = HomeKitUnpairedDevice(self, _id, dev)
                except HapError as e:
                    print('Error communicating with device {}: {}'
                          .format(dev['id'], e))
                    continue
                except DatabaseError as e:
                    print('Database error: {}'.format(e))
                    raise

                self.handle_device_added(device)
            elif isinstance(self.devices[_id], HomeKitBridge):
                self.devices[_id].find_new_devices()

    def cancel_pairing(self):
        """Cancel the pairing process."""
        self.pairing = False

    def set_pin(self, device_id, pin):
        """
        Set the PIN for the given device.

        device_id -- ID of device
        pin -- PIN to set
        """
        device = self.get_device(device_id)
        if device:
            if isinstance(device, HomeKitUnpairedDevice):
                try:
                    device.pair(pin)
                    dev = device.dev

                    if dev['ci'] in ['Outlet', 'Switch']:
                        device = HomeKitPlug(self, device_id, dev)
                    elif dev['ci'] == 'Lightbulb':
                        device = HomeKitBulb(self, device_id, dev)
                    elif dev['ci'] == 'Bridge':
                        device = HomeKitBridge(self, device_id, dev)

                    # Replace the unpaired device with the proper device type.
                    self.devices[device_id] = device
                except (DatabaseError, PairingError) as e:
                    print('Failed to pair with device {}: {}'
                          .format(device_id, e))

                    # set_pin() should never be called when SetPinError is not
                    # present, so this is safe.
                    raise SetPinError(str(e))
            else:
                raise SetPinError('Device already paired')

    def remove_thing(self, device_id):
        """
        Unpair a device with the adapter.

        device_id -- ID of device to unpair
        """
        device = self.get_device(device_id)
        if device and not isinstance(device, HomeKitUnpairedDevice):
            if device.bridge is None:
                if device.client.unpair():
                    database = HomeKitDatabase(self.package_name)
                    database.open()
                    database.remove_pairing_data(device.dev['id'])
                    database.close()
            else:
                device.bridge.remove_device(device_id)

            self.handle_device_removed(device)

    def unpair_all(self):
        """Unpair all devices."""
        database = HomeKitDatabase(self.package_name)
        database.open()

        for dev in self.devices.values():
            if isinstance(dev, HomeKitUnpairedDevice) or \
                    dev.bridge is not None:
                continue

            if dev.client.unpair():
                database.remove_pairing_data(dev.dev['id'])

        database.close()
