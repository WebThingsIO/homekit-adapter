# homekit-adapter

HomeKit device adapter for Mozilla IoT Gateway

# Supported Devices

**NOTE**: Devices typically need to be unpaired from Android/iOS before using them with the gateway.

## Tested and Working

* Smart plugs (represented as `onOffSwitch`)
    * [iDevices Switch](https://store.idevicesinc.com/idevices-switch/)
    * [Koogeek P1](https://www.koogeek.com/p-p1.html)
* Bridges
    * [Homebridge](https://github.com/nfarina/homebridge)
    * [Philips Hue Bridge v2](https://www2.meethue.com/en-us/p/hue-bridge/046677458478)

## Untested but _Should Work_

* All other WiFi smart plugs
* All WiFi light bulbs
* All other bridge devices

# Requirements

If you're running this add-on outside of the official gateway image for the Raspberry Pi, i.e. you're running on a development machine, you'll need to do the following (adapt as necessary for non-Ubuntu/Debian):

```bash
$ sudo apt install python3-dev libnanomsg-dev
$ sudo pip3 install \
    git+https://github.com/mozilla-iot/gateway-addon-python.git \
    git+https://github.com/mrstegeman/hapclient.git \
    git+https://github.com/pyca/pynacl
```
