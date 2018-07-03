# homekit-adapter

HomeKit device adapter for Mozilla IoT Gateway

# Supported Devices

**NOTE**: Devices typically need to be unpaired from Android/iOS before using them with the gateway.

## Tested and Working

* Smart plugs
    * [iDevices Switch](https://store.idevicesinc.com/idevices-switch/)
    * [Koogeek P1](https://www.koogeek.com/p-p1.html)
* Bridges
    * [Homebridge](https://github.com/nfarina/homebridge)
    * [Philips Hue Bridge v2](https://www2.meethue.com/en-us/p/hue-bridge/046677458478)
* Light bulbs
    * [LIFX A19](https://www.lifx.com/products/lifx)

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

# Installation

This add-on can be installed through the UI, via _Settings -> Add-ons -> +_.

**NOTE:** When installing this add-on, its dependencies are built at installation time, which could take several minutes. Please be patient.

# Configuration

When new devices are detected, they are added to the add-on's config with a blank PIN entry. Therefore, to configure each device's PIN, do the following:

1. Start a search for new devices from the _Things_ screen.
2. After the search has completed, navigate to _Settings -> Add-ons_.
3. Click on the _Configure_ button for the HomeKit add-on.
4. Any new devices should be auto-populated in the _pinCodes_ list. Fill in the PIN for each as required.
5. Click _Apply_.
6. After a few seconds, go back to the _Things_ screen and start a new search again.
7. If everything went well, your devices should now be available.

## Manual Configuration

If your devices were not auto-populated in the configuration screen, you can find them as follows:

1. Find the ID of your device(s) with an mDNS browser:
    * Linux:

        ```bash
        $ ## Installation may be different for your distro
        $ sudo apt update
        $ sudo apt install avahi-utils
        $ ## Now search
        $ avahi-browse -r _hap._tcp
        ```

    * Mac OS X:

        ```bash
        $ dns-sd -Z _hap._tcp
        ```

2. The ID is listed as part of the TXT record for the service.
3. Find the PIN codes for each of your devices. These are typically on a sticker on the device itself and look like `123-45-678`.
4. Launch the config editor by navigating to _Settings -> Add-ons_ and clicking the _Configure_ button for the HomeKit add-on.
5. Add a new entry for your device by clicking _+_ and filling in the fields.
6. Click _Apply_.
7. After a few seconds, go back to the _Things_ screen and start a new search again.
8. If everything went well, your devices should now be available.
