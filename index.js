// homebridge-soma/index.js
// Copyright © 2021-2022 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const SomaPlatform = require('./lib/SomaPlatform')
const packageJson = require('./package.json')

module.exports = (homebridge) => {
  SomaPlatform.loadPlatform(homebridge, packageJson, 'SOMA', SomaPlatform)
}
