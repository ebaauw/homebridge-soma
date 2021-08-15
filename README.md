<p align="center">
  <img src="homebridge-soma.png" height="200px">  
</p>
<span align="center">

# Homebridge SOMA
[![Downloads](https://img.shields.io/npm/dt/homebridge-soma.svg)](https://www.npmjs.com/package/homebridge-soma)
[![Version](https://img.shields.io/npm/v/homebridge-soma.svg)](https://www.npmjs.com/package/homebridge-soma)
[![Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=728ED5&logo=discord&label=discord)](https://discord.gg/yGvADWt)
<!-- [![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins) -->

[![GitHub issues](https://img.shields.io/github/issues/ebaauw/homebridge-soma)](https://github.com/ebaauw/homebridge-soma/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/ebaauw/homebridge-soma)](https://github.com/ebaauw/homebridge-soma/pulls)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

</span>

## Homebridge plugin for SOMA devices
Copyright © 2021 Erik Baauw. All rights reserved.

This **experimental** [Homebridge](https://github.com/homebridge/homebridge) plugin
aspires to expose
[SOMA Smart Shades 2](https://eu.somasmarthome.com) and
[SOMA Tilt 2](https://eu.somasmarthome.com/pages/smart-tilt) devices,
natively over Bluetooth Low Energy (BLE),
to Apple's [HomeKit](https://www.apple.com/ios/home/).

### Work in Progress
This plugin is still under development.
It is my first venture into Bluetooth, so I expect some ironing before it
will be stable.
Currently, the plugin discovers and monitors the shades, logging state changes.
However, it does not yet expose any accessories to HomeKit.
The `discover` and `probe` commands of the `ble` and `soma` command-line tools
are functional.

If you're looking for a functional plugin, check out
[Homebridge SC](https://github.com/ebaauw/homebridge-sc).

### Bluetooth Low Energy (BLE)
This plugin communicates to the SOMA devices over Bluetooth Low Energy (BLE).
While their Bluetooth API hasn't been published, Wazombi Labs OÜ have been very
helpful providing me the information needed to communicate with the SOMA devices.

This plugins uses [Noble](https://github.com/abandonware/noble) to access BLE
from NodeJS.
While no longer maintained by its original authors, the
[Abandonware](https://abandonware.github.io) community have adopted Noble.
It seems to run fine on a Raspberry Pi.
On macOS, discovering and monitoring a shade works, but reading or controlling
it seems to fail.
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

Note that this plugin is still under development.

### Command-Line Tool
Homebridge SOMA includes two command-line tools, `ble`, to interact with generic
BLE devices, and `soma` to interact with SOMA devices specifically.
Both tools take a `-h` or `--help` argument to provide a brief overview of
their functionality and command-line arguments.

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
