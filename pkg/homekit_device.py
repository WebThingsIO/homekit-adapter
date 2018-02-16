"""HomeKit adapter for Mozilla IoT Gateway."""

from gateway_addon import Device
from pyHS100 import SmartDevice
import threading
import time

from .homekit_property import HomeKitBulbProperty, HomeKitPlugProperty
from .util import hsv_to_rgb


_POLL_INTERVAL = 5


class HomeKitDevice(Device):
    """HomeKit device type."""

    def __init__(self, adapter, _id, hs100_dev, sysinfo):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        hs100_dev -- the pyHS100 device object to initialize from
        sysinfo -- current sysinfo dict for the device
        """
        Device.__init__(self, adapter, _id)

        self.hs100_dev = hs100_dev
        self.description = sysinfo['model']
        self.name = sysinfo['alias']
        if not self.name:
            self.name = self.description

        t = threading.Thread(target=self.poll)
        t.daemon = True
        t.start()


class HomeKitPlug(HomeKitDevice):
    """HomeKit smart plug type."""

    def __init__(self, adapter, _id, hs100_dev):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        hs100_dev -- the pyHS100 device object to initialize from
        """
        sysinfo = hs100_dev.sys_info
        HomeKitDevice.__init__(self, adapter, _id, hs100_dev, sysinfo)

        if self.has_emeter(sysinfo):
            # emeter comes via a separate API call, so use it.
            emeter = hs100_dev.get_emeter_realtime()
            power = self.power(emeter)
            if power is None:
                self.type = 'onOffSwitch'
            else:
                self.type = 'smartPlug'

                self.properties['instantaneousPower'] = \
                    HomeKitPlugProperty(self,
                                        'instantaneousPower',
                                        {'type': 'number', 'unit': 'watt'},
                                        power)

                voltage = self.voltage(emeter)
                if voltage is not None:
                    self.properties['voltage'] = \
                        HomeKitPlugProperty(self,
                                            'voltage',
                                            {'type': 'number', 'unit': 'volt'},
                                            voltage)

                current = self.current(emeter)
                if current is not None:
                    self.properties['current'] = \
                        HomeKitPlugProperty(self,
                                            'current',
                                            {'type': 'number',
                                             'unit': 'ampere'},
                                            current)
        else:
            self.type = 'onOffSwitch'

        self.properties['on'] = HomeKitPlugProperty(
            self, 'on', {'type': 'boolean'}, self.is_on(sysinfo))

    def poll(self):
        """Poll the device for changes."""
        while True:
            time.sleep(_POLL_INTERVAL)
            sysinfo = self.hs100_dev.sys_info
            if sysinfo is None:
                continue

            emeter = self.hs100_dev.get_emeter_realtime()
            for prop in self.properties.values():
                prop.update(sysinfo, emeter)

    @staticmethod
    def has_emeter(sysinfo):
        """
        Determine whether or not the plug has power monitoring.

        sysinfo -- current sysinfo dict for the device
        """
        features = sysinfo['feature'].split(':')
        return SmartDevice.FEATURE_ENERGY_METER in features

    @staticmethod
    def is_on(sysinfo):
        """
        Determine whether or not the light is on.

        sysinfo -- current sysinfo dict for the device
        """
        return bool(sysinfo['relay_state'])

    @staticmethod
    def power(emeter):
        """
        Determine the current power usage, in watts.

        emeter -- current emeter dict for the device
        """
        if 'power' in emeter:
            return emeter['power']

        if 'power_mw' in emeter:
            return emeter['power_mw'] / 1000

        return None

    @staticmethod
    def voltage(emeter):
        """
        Determine the current voltage, in volts.

        emeter -- current emeter dict for the device
        """
        if 'voltage' in emeter:
            return emeter['voltage']

        if 'voltage_mv' in emeter:
            return emeter['voltage_mv'] / 1000

        return None

    @staticmethod
    def current(emeter):
        """
        Determine the current current, in amperes.

        emeter -- current emeter dict for the device
        """
        if 'current' in emeter:
            return emeter['current']

        if 'current_ma' in emeter:
            return emeter['current_ma'] / 1000

        return None


class HomeKitBulb(HomeKitDevice):
    """HomeKit smart bulb type."""

    def __init__(self, adapter, _id, hs100_dev):
        """
        Initialize the object.

        adapter -- the Adapter managing this device
        _id -- ID of this device
        hs100_dev -- the pyHS100 device object to initialize from
        """
        sysinfo = hs100_dev.sys_info
        HomeKitDevice.__init__(self, adapter, _id, hs100_dev, sysinfo)

        # Light state, i.e. color, brightness, on/off, comes via a separate API
        # call, so use it.
        state = hs100_dev.get_light_state()

        if self.is_dimmable(sysinfo):
            if self.is_color(sysinfo):
                self.type = 'dimmableColorLight'

                self.properties['color'] = \
                    HomeKitBulbProperty(self,
                                        'color',
                                        {'type': 'string'},
                                        hsv_to_rgb(*self.hsv(state)))
            else:
                self.type = 'dimmableLight'

            self.properties['level'] = \
                HomeKitBulbProperty(self,
                                    'level',
                                    {'type': 'number',
                                     'unit': 'percent',
                                     'min': 0,
                                     'max': 100},
                                    self.brightness(state))
        else:
            if self.is_color(sysinfo):
                self.type = 'onOffColorLight'

                self.properties['color'] = \
                    HomeKitBulbProperty(self,
                                        'color',
                                        {'type': 'string'},
                                        hsv_to_rgb(*self.hsv(state)))
            else:
                self.type = 'onOffLight'

        self.properties['on'] = HomeKitBulbProperty(
            self, 'on', {'type': 'boolean'}, self.is_on(state))

        # TODO: power consumption, temperature

    def poll(self):
        """Poll the device for changes."""
        while True:
            time.sleep(_POLL_INTERVAL)
            sysinfo = self.hs100_dev.sys_info
            if sysinfo is None:
                continue

            state = self.hs100_dev.get_light_state()
            for prop in self.properties.values():
                prop.update(sysinfo, state)

    @staticmethod
    def is_dimmable(sysinfo):
        """
        Determine whether or not the light is dimmable.

        sysinfo -- current sysinfo dict for the device
        """
        return bool(sysinfo['is_dimmable'])

    @staticmethod
    def is_color(sysinfo):
        """
        Determine whether or not the light is color-changing.

        sysinfo -- current sysinfo dict for the device
        """
        return bool(sysinfo['is_color'])

    @staticmethod
    def is_on(light_state):
        """
        Determine whether or not the light is on.

        light_state -- current state of the light
        """
        return bool(light_state['on_off'])

    @staticmethod
    def hsv(light_state):
        """
        Determine the current color of the light.

        light_state -- current state of the light
        """
        if not HomeKitBulb.is_on(light_state):
            light_state = light_state['dft_on_state']

        hue = light_state['hue']
        saturation = light_state['saturation']
        value = int(light_state['brightness'] * 255 / 100)

        return hue, saturation, value

    @staticmethod
    def brightness(light_state):
        """
        Determine the current brightness of the light.

        light_state -- current state of the light
        """
        if not HomeKitBulb.is_on(light_state):
            light_state = light_state['dft_on_state']

        return int(light_state['brightness'])
