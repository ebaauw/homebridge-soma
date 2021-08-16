// homebridge-soma/lib/SomaPlatform.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const SomaClient = require('./SomaClient')

class SomaPlatform extends homebridgeLib.Platform {
  constructor (log, configJson, homebridge) {
    super(log, configJson, homebridge)
    this.config = {
      timeout: 15
    }
    const optionParser = new homebridgeLib.OptionParser(this.config, true)
    optionParser
      .stringKey('platform')
      .stringKey('name')
      .intKey('timeout', 1, 60) // seconds
      .on('userInputError', (message) => {
        this.warn('config.json: %s', message)
      })
    try {
      optionParser.parse(configJson)
    } catch (error) { this.error(error) }

    this.shades = {}

    this
      .on('accessoryRestored', this.accessoryRestored)
      .once('heartbeat', this.init)
    this.debug('config: %j', this.config)
    this.warn('this plugin is still under development and not yet functional')
  }

  async init (beat) {
    this.client = new SomaClient()
    this.client
      .on('error', (error) => {
        if (error instanceof SomaClient.BleError) {
          this.log('request %d: %s', error.request.id, error.request.request)
          this.warn('request %d: %s', error.request.id, error)
          return
        }
        this.warn(error)
      })
      .on('request', (request) => {
        this.debug('request: %d: %s', request.id, request.request)
      })
      .on('response', (response) => {
        this.debug(
          'request %d: %s: ok', response.request.id, response.request.request
        )
      })
      .on('enabled', (platform, arch) => {
        this.debug('bluetooth enabled [%s on %s]', platform, arch)
      })
      .on('disabled', () => { this.error('bluetooth disabled') })
      .on('searching', () => { this.debug('searching...') })
      .on('stopSearching', () => { this.debug('search ended') })
      // .on('deviceFound', async (device) => {
      //   const name = device.name != null
      //     ? ' [' + device.name + ']'
      //     : ''
      //   const manufacturer = device.manufacturer != null
      //     ? ' by ' + device.manufacturer.name
      //     : ''
      //   const address = device.address != null
      //     ? ' at ' + device.address
      //     : ''
      //   this.debug('found %s%s%s%s', device.id, name, manufacturer, address)
      //   this.vdebug(
      //     'found %s%s%s%s %j', device.id, name, manufacturer, address,
      //     device.peripheral.advertisement
      //   )
      // })
      .on('shadeFound', async (device) => {
        if (this.shades[device.id] == null) {
          const name = device.displayName != null
            ? ' [' + device.displayName + ']'
            : ''
          this.debug(
            'found %s%s at %s [position: %d, battery: %j%%]', device.id, name,
            device.address, device.currentPosition, device.battery
          )
          this.shades[device.id] = {
            displayName: device.displayName,
            currentPosition: device.currentPosition,
            targetPosition: device.targetPosition,
            battery: device.battery,
            lastSeen: new Date()
          }
          this.log(
            '%s: currentPosition %d%%', device.displayName,
            device.currentPosition
          )
          this.log(
            '%s: targetPosition %d%%', device.displayName,
            device.targetPosition
          )
          this.log(
            '%s: currentPosition %d%%', device.displayName,
            device.currentPosition
          )
          this.log(
            '%s: battery %d%%', device.displayName,
            device.battery
          )
        } else {
          const shade = this.shades[device.id]
          const now = new Date()
          if (device.displayName !== shade.displayName) {
            this.log(
              '%s: displayName changed from %s to %s', device.displayName,
              shade.displayName, device.displayName
            )
            shade.displayName = device.displayName
          }
          if (device.currentPosition !== shade.currentPosition) {
            this.log(
              '%s: currentPosition changed from %d%% to %d%%', device.displayName,
              shade.currentPosition, device.currentPosition
            )
            shade.currentPosition = device.currentPosition
          }
          if (device.targetPosition !== shade.targetPosition) {
            this.log(
              '%s: targetPosition changed from %d%% to %d%%', device.displayName,
              shade.targetPosition, device.targetPosition
            )
            shade.targetPosition = device.targetPosition
          }
          if (device.battery !== shade.battery) {
            this.log(
              '%s: battery changed from %d%% to %d%%', device.displayName,
              shade.battery, device.battery
            )
            shade.battery = device.battery
          }
          if (now - shade.lastSeen >= 60000) {
            this.log(
              '%s: lastSeen changed from %s to %s', device.displayName,
              shade.lastSeen.toISOString().slice(0, -8) + 'Z',
              now.toISOString().slice(0, -8) + 'Z'
            )
            shade.lastSeen = now
          }
        }
      })
  }

  accessoryRestored (className, version, id, name, context) {
    switch (className) {
      default:
        this.warn(
          '%s: ignore unknown %s %v accesssory', name, className, version
        )
        break
    }
  }
}

module.exports = SomaPlatform
