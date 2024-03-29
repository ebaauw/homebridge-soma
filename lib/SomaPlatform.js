// homebridge-soma/lib/SomaPlatform.js
// Copyright © 2021-2022 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const { semver } = homebridgeLib
const SomaClient = require('./SomaClient')
const SomaAccessory = require('./SomaAccessory')

const { bufferToHex } = require('../lib/BleUtils')

const noop = () => {}

class SomaPlatform extends homebridgeLib.Platform {
  constructor (log, configJson, homebridge) {
    super(log, configJson, homebridge)
    this.config = {
      restartInterval: Infinity,
      rssi: -100,
      timeout: 15
    }
    const optionParser = new homebridgeLib.OptionParser(this.config, true)
    optionParser
      .stringKey('platform')
      .stringKey('name')
      .arrayKey('shades')
      .intKey('restartInterval', 1, 12) // hours
      .intKey('rssi', -100, -50)
      .intKey('timeout', 1, 60) // seconds
      .on('userInputError', (message) => {
        this.warn('config.json: %s', message)
      })
    try {
      optionParser.parse(configJson)
      this.config.restartInterval *= 3600 // hours -> seconds
    } catch (error) { this.error(error) }

    this.shades = {}

    this
      .on('accessoryRestored', this.accessoryRestored)
      .once('heartbeat', this.init)
      .on('heartbeat', this.heartbeat)
    this.debug('config: %j', this.config)
  }

  isWhitelisted (name, address) {
    return this.config.shades == null ||
      this.config.shades.includes(name) || this.config.shades.includes(address)
  }

  async init (beat) {
    this.warn('This plugin is no longer being maintained, see README.')
    this.emit('initialised')
    this.client = new SomaClient({ rssi: this.config.rssi, scanDuration: 0 })
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
      .on('enabled', (config) => {
        this.debug('hardware: %s', config.hwInfo.prettyName)
        this.debug('os: %s', config.osInfo.prettyName)
        if (!config.supported) {
          this.warn('unsupported platform')
        }
        this.log(
          '%s%s enabled', config.adapter,
          config.address == null ? '' : ' [' + config.address + ']'
        )
      })
      .on('disabled', (config) => {
        this.debug('hardware: %s', config.hwInfo.prettyName)
        this.debug('os: %s', config.osInfo.prettyName)
        if (!config.supported) {
          this.warn('unsupported platform')
        }
        this.error(
          '%s%s disabled', config.adapter,
          config.address == null ? '' : ' [' + config.address + ']'
        )
      })
      .on('scanStart', (me) => {
        this.debug('scanning started by %s', me ? 'me' : 'someone else')
      })
      .on('scanStop', (me) => {
        this.debug('scanning stopped by %s', me ? 'me' : 'someone else')
      })
      .on('shadeFound', async (device) => {
        if (this.inHeartbeat) {
          return
        }
        if (this.shades[device.id] == null) {
          const name = device.name != null
            ? ' [' + device.name + ']'
            : ''
          const manufacturer = device.manufacturer != null
            ? ' by ' + device.manufacturer.name
            : ''
          const address = device.address != null
            ? ' at ' + device.address
            : ''
          this.debug(
            'found %s%s%s%s %j', device.id, name, manufacturer, address,
            device.data
          )
          this.shades[device.id] = {
            onDeviceFound: noop,
            heartbeat: noop
          }
          if (!this.isWhitelisted(device.data.displayName, device.address)) {
            this.log('%s [%s]: not whitelisted', device.data.displayName, device.address)
            return
          }
          const delegate = this.createDelegate(device)
          try {
            const params = {
              id: (await delegate.getShadeMacAddress()).replace(/-/g, ''),
              deviceId: device.id,
              address: device.address,
              name: device.data.displayName,
              firmware: await delegate.getSoftwareRevision(),
              hardware: await delegate.getHardwareRevision(),
              venetianMode: device.data.venetianMode
            }
            this.debug('%s: %j', device.data.displayName, params)
            this.shades[device.id] = new SomaAccessory(this, params)
          } catch (error) {
            if (!(error instanceof SomaClient.BleError)) {
              this.error('%s: %s', device.id, error)
            }
            setTimeout(() => { delete this.shades[device.id] }, 5000)
            return
          } finally {
            try {
              await delegate.disconnect()
            } catch (error) {
              if (!(error instanceof SomaClient.BleError)) {
                this.error('%s: %s', device.id, error)
              }
            }
            delegate.destroy()
            delegate.removeAllListeners()
          }
        }
        try {
          await this.shades[device.id].onDeviceFound(device)
        } catch (error) {
          if (!(error instanceof SomaClient.BleError)) {
            this.error('%s: %s', device.id, error)
          }
        }
      })
  }

  async heartbeat (beat) {
    if (beat % this.config.restartInterval === this.config.restartInterval - 1) {
      this.needRestart = true
    }
    // if (beat % 300 === 300 - 1) {
    //   this.needReset = true
    // }
    if (this.inHeartbeat) {
      return
    }
    // if (this.needReset) {
    //   delete this.needReset
    //   await this.client.reset()
    // }
    this.inHeartbeat = true
    for (const id in this.shades) {
      await this.shades[id].heartbeat(beat)
    }
    if (this.needRestart) {
      delete this.needRestart
      this.fatal('scheduled restart')
    }
    this.inHeartbeat = false
  }

  createDelegate (device, bleError = true) {
    const delegate = new SomaClient.SomaPeripheral(this.client, device)
    delegate
      .on('error', (error) => {
        if (error instanceof SomaClient.BleError) {
          if (bleError || this.debug) {
            this.warn('%s: request %d: %s', delegate.id, error.request.id, error)
          }
          return
        }
        this.warn('%s: %s', delegate.id, error)
      })
      .on('request', (request) => {
        this.debug('%s: request %d: %s', delegate.id, request.id, request.request)
      })
      .on('response', (response) => {
        if (response.parsedValue == null) {
          this.debug(
            '%s: request %d: %s: ok', delegate.id, response.request.id,
            response.request.request
          )
        } else {
          this.debug(
            '%s: request %d: %s: response: %j', delegate.id, response.request.id,
            response.request.request, response.parsedValue
          )
        }
        if (response.buffer != null) {
          this.vdebug(
            '%s: request %d: response buffer: %j', delegate.id,
            response.request.id, bufferToHex(response.buffer)
          )
        }
      })
      .on('connected', (rssi) => {
        this.debug('%s: connected (rssi: %d)', delegate.id, rssi)
      })
      .on('disconnected', () => { this.debug('%s: disconnected', delegate.id) })
    return delegate
  }

  accessoryRestored (className, version, id, name, context) {
    switch (className) {
      case 'SomaAccessory':
        if (
          semver.gte(version, '0.0.14') &&
          this.isWhitelisted(context.name, context.address)
        ) {
          this.shades[context.deviceId] = new SomaAccessory(this, context)
        }
        break
      default:
        this.warn(
          '%s: ignore unknown %s v%s', name, className, version
        )
        break
    }
  }
}

module.exports = SomaPlatform
