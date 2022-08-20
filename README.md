<p align="center">
  <img src="homebridge-soma.png" height="200px">  
</p>
<span align="center">

# Homebridge SOMA
[![Downloads](https://img.shields.io/npm/dt/homebridge-soma.svg)](https://www.npmjs.com/package/homebridge-soma)
[![Version](https://img.shields.io/npm/v/homebridge-soma.svg)](https://www.npmjs.com/package/homebridge-soma)
[![Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=728ED5&logo=discord&label=discord)](https://discord.gg/yGvADWt)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

[![GitHub issues](https://img.shields.io/github/issues/ebaauw/homebridge-soma)](https://github.com/ebaauw/homebridge-soma/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/ebaauw/homebridge-soma)](https://github.com/ebaauw/homebridge-soma/pulls)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

</span>


## Homebridge plugin for SOMA devices
Copyright © 2021-2022 Erik Baauw. All rights reserved.

*Note: This plugin is no longer being maintained.*

This [Homebridge](https://github.com/homebridge/homebridge) plugin exposes to Apple's [HomeKit](https://www.apple.com/ios/home/):
[SOMA Smart Shades](https://eu.somasmarthome.com) and [SOMA Tilt](https://eu.somasmarthome.com/pages/smart-tilt) devices, using the native Bluetooth Low Energy (BLE) interface to communicate with the devices.

Using BLE from NodeJS proves to be quite challenging, see
[Bluetooth Low Energy (BLE)](bluetooth-low-energy-ble) below.
I only expect this plugin to function when running on a Raspberry Pi.
Even then, the BLE connection to the SOMA devices doesn't meet my standard for reliability and I am no longer using this plugin myself.

For production, I recommend to use [Homebridge SC](https://github.com/ebaauw/homebridge-sc) instead, which uses the SOMA Connect instead of BLE to communicate with the SOMA devices.

Homebridge SOMA provides the following features:
- Automatic discovery of SOMA devices.
- Each device is exposed as a HomeKit accessory with a _Window Covering_ and a _Battery_ service.
Each trigger is exposed as a separate custom _Resource_ service.  
Note that _Current Ambient Light Level_ on the _Windows Covering_ service reports the raw value as reported by the solar panel, not the value in lux as expected by HomeKit.

- The _Window Covering_ service carries additional custom characteristics:
  - _Close Upwards_ (for Tilt devices): indicates whether the blinds are (to be)
  tilted upwards;
  - _Morning Mode_ (not yet implemented): move the device slowly,
  making less noise;
  - _Last Seen_: updated (once a minute) as BLE advertisements are received;
  - _Motor Speed_: to set the speed of the motor;
  - _Current Ambient Light Level_: the raw light level as reported by the solar panel;
  - _Last Updated_: updated when the device is polled;
  - _Sunrise_: the sunrise time, as computed by the device;
  - _Sunset_: the sunset time, as computed by the device.
  - _Log Level_: sets the level of debug messages.  Note that Homebridge debug
  mode must be enabled for level 2 and above;
  - _Heartrate_: sets the polling rate;
  - _Restart_: restart the device.

- Each _Resource_ service carries custom characteristics:
  - _Enabled_: to enable/disable the trigger;
  - _Resource_: shows the trigger condition.

- _Current Position_ and _Battery Level_ are updated from the BLE
advertisements.  _Last Seen_ is updated (once a minute) as BLE advertisements
are received.

- The other characteristics are updated by polling the device.
_Last Updated_ is updated when the device is polled.
The polling rate can be set dynamically using _Heartrate_.
Issue _Identify_ (on the _Accessory Information_ service) to force poll the
device immediately, and to play a sound on the device.

- Keep the device clock and timezone offset in sync with the server running
Homebridge, for when you don't use the SOMA Connect nor SOMA Smart Shades app.

Note that Apple's Home app doesn't support custom services nor characteristics.
To use the full features of Homebridge SOMA, you need a decent HomeKit app,
like [Eve](https://www.evehome.com/en-us/eve-app).

### Command-Line Tool
Homebridge SOMA includes two command-line tools, `ble`, to interact with generic
BLE devices, and `soma` to interact with SOMA devices specifically.
Both tools take a `-h` or `--help` argument to provide a brief overview of
their functionality and command-line arguments.

### Bluetooth Low Energy (BLE)
This plugin communicates with the SOMA devices over Bluetooth Low Energy (BLE).
While their Bluetooth API hasn't been published,
Wazombi Labs OÜ have been very helpful providing me the information
needed to expose all features of the SOMA devices.

This plugin uses [Noble](https://github.com/abandonware/noble) to interact with
BLE from NodeJS.
While no longer maintained by its original authors, the
[Abandonware](https://abandonware.github.io) community have adopted Noble.
It seems to run reasonably well on a Raspberry Pi.
On macOS, it no longer does.
I don't have Windows, nor Docker, nor any other container, nor VMs to test, but
there seem plenty of open issues trying to run Noble on these.

Bottom line: this plugin is supported only running natively on a Raspberry Pi.
Obviously, this should be a Pi with BLE hardware, such as the 4B, 3B+, 3B, 3A+,
or Zero W.
I have had mixed results using USB dongles for BLE support, see [issue 6](https://github.com/ebaauw/homebridge-soma/issues/6).

Before installing this plugin, be sure to install Noble's dependencies:
```
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```
and to allow NodeJS to access the BLE hardware:
```
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
```
Note that this last command needs to be repeated after each update of NodeJS.

### Configuration
In Homebridge's `config.json` you need to specify Homebridge SOMA as a platform
plugin.
```json
  "platforms": [
    {
      "platform": "SOMA"
    }
  ]
```
I strongly recommend to run Homebridge SOMA isolated, in a seperate
[child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges).

### Troubleshooting

#### Check Dependencies
If you run into Homebridge startup issues, please double-check what versions
of Node.js and of Homebridge have been installed.
Homebridge SOMA has been developed and tested using the
[latest LTS](https://nodejs.org/en/about/releases/) version of Node.js
and the [latest](https://www.npmjs.com/package/homebridge) version of Homebridge.
Other versions might or might not work - I simply don't have the bandwidth
to test these.

As mentioned above, I only expect Homebridge SOMA to run on a Raspberry Pi,
due to issues with the Noble library for communicating with BLE devices.

#### Run Homebridge SOMA Solo
If you run into Homebridge issues, please run Homebridge SOMA in a separate
[child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges).
This way, you can determine whether the issue is related to Homebridge SOMA itself,
or to the interaction of multiple Homebridge plugins in your setup.

#### Getting Help
I cannot help you with issues related to Bluetooth connectivity.
I am no longer working on this plugin.
If you have a question, please post a message to the **#soma** channel of the
Homebridge community on [Discord](https://discord.gg/aCTWrqb).
