# homekit-adapter

HomeKit device adapter for WebThings Gateway

## Supported Devices

**NOTE**: Devices typically need to be unpaired from Android/iOS before using
them with the gateway.

### Tested and Working

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

### Untested but _Should Work_

Most other WiFi and BLE devices should work.

## Installation

This add-on can be installed through the UI, via _Settings -> Add-ons -> +_.

## Usage

Devices should be automatically discovered by the add-on. From the main Things
screen, click the + button in the lower right. You will be asked for the PIN
for your device, which is usually on a sticker.

If your device instead displays a PIN on-screen during the pairing process,
you will need to enter `000-00-000`. After it gives you an invalid PIN error,
you should then enter the PIN displayed on your screen.

## Troubleshooting

If you're having issues pairing, some of the following steps may help.

* Pair the device with iOS and update the firmware. You will have to then
  unpair or reset the device before attempting to pair with the gateway again.
* Perform a hard reset on the device.
    * This typically requires you to hold a button on the device for 10-15
      seconds. See device manual.

If you're having errors with Bluetooth devices in particular:

* The Raspberry Pi Bluetooth and WiFi devices are on the same chip. As such,
  they can cause interference with one another. As such, they can conflict with
  one another and cause lots of timeouts/disconnections. To resolve these
  issues, it is recommended that you connect your Raspberry Pi via ethernet and
  disable the WiFi connection. For instructions on how to do so,
  [see here](https://raspberrypi.stackexchange.com/a/62522).
