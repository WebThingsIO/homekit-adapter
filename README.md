# homekit-adapter

HomeKit device adapter for Mozilla IoT Gateway

# Supported Devices

**NOTE**: Devices typically need to be unpaired from Android/iOS before using them with the gateway.

## Tested and Working

* Smart plugs
    * [iDevices Switch](https://store.idevicesinc.com/idevices-switch/)
    * [Koogeek P1](https://www.koogeek.com/p-p1.html)
    * [Eve Energy](https://www.evehome.com/en/eve-energy)
* Bridges
    * [Homebridge](https://github.com/nfarina/homebridge)
    * [Philips Hue Bridge v2](https://www2.meethue.com/en-us/p/hue-bridge/046677458478)
* Light bulbs
    * [LIFX A19](https://www.lifx.com/products/lifx)
* Sensors
    * [Eve Door &amp; Window](https://www.evehome.com/en/eve-door-window)
    * [Eve Motion](https://www.evehome.com/en/eve-motion)

## Untested but _Should Work_

Most other WiFi and BLE devices should work.

# Installation

This add-on can be installed through the UI, via _Settings -> Add-ons -> +_.

**NOTE:** If you plan to use BLE devices, and you have the "Web Thing" add-on installed, you should disable Bluetooth scanning in that add-on by navigating to _Settings -> Add-ons_, clicking _Configure_ next to "Web Thing", setting _bluetoothEnabled_ to false (unchecked), then clicking _Apply_.

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

## Troubleshooting

If you're having issues pairing, some of the following steps may help.

* Pair the device with iOS and update the firmware. You will have to then unpair or reset the device before attempting to pair with the gateway again.
* Perform a hard reset on the device.
    * This typically requires you to hold a button on the device for 10-15 seconds. See device manual.
* [Configure the PIN manually](#manual-configuration) (starting at step 3). Sometimes this works better than setting the PIN through the _Add New Things_ screen.
