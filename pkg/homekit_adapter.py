"""HomeKit adapter for Mozilla IoT Gateway."""

from gateway_addon import Adapter
from pyHS100 import Discover, SmartBulb, SmartPlug

from .homekit_device import HomeKitBulb, HomeKitPlug


_TIMEOUT = 3


class HomeKitAdapter(Adapter):
    """Adapter for HomeKit devices."""

    def __init__(self, verbose=False):
        """
        Initialize the object.

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
        for dev in Discover.discover(timeout=min(timeout, _TIMEOUT)).values():
            if not self.pairing:
                break

            _id = 'homekit-' + dev.sys_info['deviceId']
            if _id not in self.devices:
                if isinstance(dev, SmartPlug):
                    device = HomeKitPlug(self, _id, dev)
                elif isinstance(dev, SmartBulb):
                    device = HomeKitBulb(self, _id, dev)
                else:
                    continue

                self.handle_device_added(device)

    def cancel_pairing(self):
        """Cancel the pairing process."""
        self.pairing = False
