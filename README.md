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

This [Homebridge](https://github.com/homebridge/homebridge) plugin exposes
to Apple's [HomeKit](https://www.apple.com/ios/home/):
[SOMA Smart Shades 2](https://eu.somasmarthome.com) and
[SOMA Tilt 2](https://eu.somasmarthome.com/pages/smart-tilt) devices,
using the native Bluetooth Low Energy (BLE) interface to communicate with the
devices.

Using BLE from NodeJS proves to be quite challenging, see
[Bluetooth Low Energy (BLE)](bluetooth-low-energy-ble) below.
Consequently, I expect this plugin to work only when running on a Raspberry Pi.
If you don't want to run a Raspberry Pi, check out
[Homebridge SC](https://github.com/ebaauw/homebridge-sc), which uses the
SOMA Connect instead of BLE to communicate with the SOMA devices.

Homebridge SOMA provides the following features:
- Automatic discovery of SOMA devices.
- Each device is exposed as a HomeKit accessory with a _Window Covering_,
a _Light Sensor_, and a _Battery_ service.
Each trigger is exposed as a separate custom _Resource_ service.  
Note that _Current Ambient Light Level_ currently reports the raw value
as reported by the solar panel.

- The _Window Covering_ service carries additional custom characteristics:
  - _Close Upwards_ (for Tilt devices): indicates whether the blinds are (to be)
  tilted upwards;
  - _Morning Mode_ (not yet implemented): move the device slowly,
  making less noise;
  - _Last Seen_: updated (once a minute) as BLE advertisements are received;
  - _Motor Speed_: to set the speed of the motor;
  - _Log Level_: sets the level of debug messages.  Note that Homebridge debug
  mode must be enabled for level 2 and above;
  - _Heartrate_: sets the polling rate;
  - _Restart_: restart the device.


- The _Light Sensor_ service carries additional custom characteristics:
  - _Last Updated_: updated when the device is polled;
  - _Sunrise_: the sunrise time, as computed by the device;
  - _Sunset_: the sunset time, as computed by the device.


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

### Work in Progress
This plugin is still under development.
It is my first venture into Bluetooth, so I expect some ironing before it
will be stable.
If you're looking for a stable plugin, check out
[Homebridge SC](https://github.com/ebaauw/homebridge-sc).

Still to do:
- Implement _Morning Mode_;
- Additional commands for `soma` to interact with the device from the command
line and/or shell scripts.

### Bluetooth Low Energy (BLE)
This plugin communicates with the SOMA devices over Bluetooth Low Energy (BLE).
While their Bluetooth API hasn't been published,
Wazombi Labs OÜ have been very helpful providing me the information
needed to expose all features of the SOMA devices.

This plugin uses [Noble](https://github.com/abandonware/noble) to interact with
BLE from NodeJS.
While no longer maintained by its original authors, the
[Abandonware](https://abandonware.github.io) community have adopted Noble.
It seems to run fine on a Raspberry Pi.
On macOS, discovering and monitoring a shade works, but the connection hands
after the first read or write.
I workaround this by reconnecting after each read or write,
but I cannot seen to get notifications to work.
I don't have Windows, nor Docker, nor any other container, nor VMs to test, but
there seem plenty of open issues trying to run Noble on these.

Bottom line: this plugin is supported only running natively on a Raspberry Pi.
Obviously, this should be a Pi with BLE hardware, such as the 4B, 3B+, 3B, 3A+,
or Zero W.
I have no experience using USB dongles for BLE support on older models.

If you don't want to run a Raspberry Pi, check out
[Homebridge SC](https://github.com/ebaauw/homebridge-sc), which uses the
SOMA Connect instead of BLE to communicate with the SOMA devices.

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
If you have a question, please post a message to the **#soma** channel of the
Homebridge community on [Discord](https://discord.gg/aCTWrqb).

If you encounter a problem, please open an issue on
[GitHub](https://github.com/ebaauw/homebridge-soma/issues).
Please enable Homebridge debug mode(using the Homebridge UI),
set _Log Level_ to 2 (using Eve),
download the Homebridge log file (using the Homebridge UI),
and **attach** it to the issue.
Please do **not** copy/paste large amounts of log output.
