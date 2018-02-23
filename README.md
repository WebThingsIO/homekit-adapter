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
$ sudo pip3 install nnpy
$ sudo pip3 install \
    hkdf \
    git+https://github.com/mozilla-iot/gateway-addon-python.git \
    git+https://github.com/mrstegeman/hapclient.git \
    git+https://github.com/mrstegeman/python-zeroconf \
    git+https://github.com/pyca/pynacl
```

# Configuration

Since there is not currently an add-on configuration UI interface, you'll need to do some manual configuration.

1. The first step is to run the add-on.
2. Log in to the gateway using one of the methods described [here](https://github.com/mozilla-iot/wiki/wiki/Logging-into-the-Raspberry-Pi).
3. Find the IDs of your devices from the log (they look like `XX:XX:XX:XX:XX:XX`):

    ```bash
    $ grep "homekit:.*Failed to create device" ~/mozilla-iot/gateway/run-app.log
    ```

    * You can also discover these using an mDNS browser, such as `avahi-browse`. The ID is listed as part of the TXT record for the service. To do this from the Raspberry Pi, do the following:

        ```bash
        $ sudo apt update
        $ sudo apt install avahi-utils
        $ avahi-browse -r _hap._tcp
        ```

4. Find the PIN codes for each of your devices. These are typically on a sticker on the device itself and look like `123-45-678`.
5. Launch the config editor:

    ```bash
    $ cd ~/mozilla-iot/gateway/tools
    $ ./config-editor.py -e homekit-adapter
    ```

    * While inside the config editor, you should see something like this:

        ```javascript
        {
          "pinCodes": {
          }
        }
        ```

    * You'll want to add a config item for each of your devices:

        ```javascript
        {
          "pinCodes": {
            "XX:XX:XX:XX:XX:XX": "123-45-678",
            "YY:YY:YY:YY:YY:YY": "876-54-321"
          }
        }
        ```

    * Save the config. If you're inside the default editor, `nano`, you can close with `CTRL-x`, then `y` and `Enter` to save.
6. Restart the gateway:

    ```bash
    $ sudo systemctl restart mozilla-iot-gateway
    ```
