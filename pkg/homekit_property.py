"""HomeKit adapter for Mozilla IoT Gateway."""

from gateway_addon import Property

from .util import hsv_to_rgb, rgb_to_hsv


class HomeKitProperty(Property):
    """HomeKit property type."""

    def __init__(self, device, aid, iid, name, description, value):
        """
        Initialize the object.

        device -- the Device this property belongs to
        aid -- the property's accessory id
        iid -- the property's instance id
        name -- name of the property
        description -- description of the property, as a dictionary
        value -- current value of this property
        """
        Property.__init__(self, device, name, description)
        self.aid = aid
        self.iid = iid
        self.set_cached_value(value)

    def set_value(self, value):
        """
        Set the current value of the property.

        value -- the value to set
        """
        ret = self.device.client.set_characteristics({
            '{}.{}'.format(self.aid, self.iid): value,
        })

        if ret:
            self.set_cached_value(value)
            self.device.notify_property_changed(self)

    def update(self, characteristics):
        """
        Update the current value, if necessary.

        characteristics -- current characteristic list for the device
        """
        c = list(
            filter(lambda x: x['aid'] == self.aid and x['iid'] == self.iid,
                   characteristics))
        if not c:
            return

        value = c[0]['value']
        if value != self.value:
            self.set_cached_value(value)
            self.device.notify_property_changed(self)


class HomeKitPlugProperty(HomeKitProperty):
    """Property type for HomeKit smart plugs."""

    def set_value(self, value):
        """
        Set the current value of the property.

        value -- the value to set
        """
        if self.name == 'on':
            HomeKitProperty.set_value(self, value)


class HomeKitBulbProperty(HomeKitProperty):
    """Property type for HomeKit smart bulbs."""

    def set_value(self, value):
        """
        Set the current value of the property.

        value -- the value to set
        """
        if self.name != 'color':
            HomeKitProperty.set_value(self, value)
            return

        # Convert color to HSV
        h, s, v = rgb_to_hsv(value)

        # Get the hue, saturation, and brightness properties
        hp = self.device.properties['_hue']
        sp = self.device.properties['_saturation']
        vp = self.device.properties['level']

        # Set all 3 values at once
        ret = self.device.client.set_characteristics({
            '{}.{}'.format(hp.aid, hp.iid): h,
            '{}.{}'.format(sp.aid, sp.iid): s,
            '{}.{}'.format(vp.aid, vp.iid): v,
        })

        if ret:
            self.set_cached_value(value)
            self.device.notify_property_changed(self)

    def update(self, characteristics):
        """
        Update the current value, if necessary.

        characteristics -- current characteristic list for the device
        """
        if self.name.startswith('_'):
            return

        if self.name != 'color':
            HomeKitProperty.update(self, characteristics)
            return

        # Get the hue property and characteristic
        hp = self.device.properties['_hue']
        hc = list(filter(lambda x: x['aid'] == hp.aid and x['iid'] == hp.iid,
                         characteristics))

        # Get the saturation property and characteristic
        sp = self.device.properties['_saturation']
        sc = list(filter(lambda x: x['aid'] == sp.aid and x['iid'] == sp.iid,
                         characteristics))

        # Get the brightness property and characteristic
        vp = self.device.properties['level']
        vc = list(filter(lambda x: x['aid'] == vp.aid and x['iid'] == vp.iid,
                         characteristics))

        if not hc or not sc or not vc:
            return

        value = hsv_to_rgb(hc[0]['value'], sc[0]['value'], vc[0]['value'])
        if value != self.value:
            self.set_cached_value(value)
            self.device.notify_property_changed(self)
