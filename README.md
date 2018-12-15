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
* Light bulbs
    * [LIFX A19](https://www.lifx.com/products/lifx)
* Sensors
    * [Eve Door &amp; Window](https://www.evehome.com/en/eve-door-window)
    * [Eve Motion](https://www.evehome.com/en/eve-motion)
    * [Eve Room](https://www.evehome.com/en/eve-room)
    * [Eve Degree](https://www.evehome.com/en/eve-degree)
    * [Fibaro Flood Sensor](https://www.fibaro.com/en/products/flood-sensor/)
* Buttons
    * [Eve Button](https://www.evehome.com/en/eve-button)

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

## Troubleshooting

If you're having issues pairing, some of the following steps may help.

* Pair the device with iOS and update the firmware. You will have to then unpair or reset the device before attempting to pair with the gateway again.
* Perform a hard reset on the device.
    * This typically requires you to hold a button on the device for 10-15 seconds. See device manual.

If you're having errors with Bluetooth devices in particular:

* The Raspberry Pi Bluetooth and WiFi devices are on the same chip. As such, they can cause interference with one another. As such, they can conflict with one another and cause lots of timeouts/disconnections. To resolve these issues, it is recommended that you connect your Raspberry Pi via ethernet and disable the WiFi connection. For instructions on how to do so, [see here](https://raspberrypi.stackexchange.com/a/62522).
