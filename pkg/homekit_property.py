"""HomeKit adapter for Mozilla IoT Gateway."""

from gateway_addon import Property

from .util import hsv_to_rgb, rgb_to_hsv


class HomeKitProperty(Property):
    """HomeKit property type."""

    def __init__(self, device, name, description, value):
        """
        Initialize the object.

        device -- the Device this property belongs to
        name -- name of the property
        description -- description of the property, as a dictionary
        value -- current value of this property
        """
        Property.__init__(self, device, name, description)
        self.set_cached_value(value)


class HomeKitPlugProperty(HomeKitProperty):
    """Property type for HomeKit smart plugs."""

    def set_value(self, value):
        """
        Set the current value of the property.

        value -- the value to set
        """
        if self.name == 'on':
            self.device.hs100_dev.state = 'ON' if value else 'OFF'
        else:
            return

        self.set_cached_value(value)
        self.device.notify_property_changed(self)

    def update(self, sysinfo, emeter):
        """
        Update the current value, if necessary.

        sysinfo -- current sysinfo dict for the device
        emeter -- current emeter for the device
        """
        if self.name == 'on':
            value = self.device.is_on(sysinfo)
        elif self.name == 'instantaneousPower':
            value = self.device.power(emeter)
        elif self.name == 'voltage':
            value = self.device.voltage(emeter)
        elif self.name == 'current':
            value = self.device.current(emeter)
        else:
            return

        if value != self.value:
            self.set_cached_value(value)
            self.device.notify_property_changed(self)


class HomeKitBulbProperty(HomeKitProperty):
    """Property type for HomeKit smart bulbs."""

    def set_value(self, value):
        """
        Set the current value of the property.

        value -- the value to set
        """
        if self.name == 'on':
            self.device.hs100_dev.state = 'ON' if value else 'OFF'
        elif self.name == 'color':
            self.device.hs100_dev.hsv = rgb_to_hsv(value)
        elif self.name == 'level':
            self.device.hs100_dev.brightness = value
        else:
            return

        self.set_cached_value(value)
        self.device.notify_property_changed(self)

    def update(self, sysinfo, light_state):
        """
        Update the current value, if necessary.

        sysinfo -- current sysinfo dict for the device
        light_state -- current state of the light
        """
        if self.name == 'on':
            value = self.device.is_on(light_state)
        elif self.name == 'color':
            value = hsv_to_rgb(*self.device.hsv(light_state))
        elif self.name == 'level':
            value = self.device.brightness(light_state)
        else:
            return

        if value != self.value:
            self.set_cached_value(value)
            self.device.notify_property_changed(self)
