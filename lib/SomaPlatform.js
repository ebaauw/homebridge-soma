// homebridge-soma/lib/SomaPlatform.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const SomaClient = require('./SomaClient')
const SomaAccessory = require('./SomaAccessory')

const { bufferToHex } = require('../lib/BleUtils')

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
    this.warn('this plugin is still under development')
  }

  async init (beat) {
    this.client = new SomaClient({ scanDuration: 0 })
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
      .on('scanStart', (me) => {
        this.debug('scanning started by %s', me ? 'me' : 'someone else')
      })
      .on('scanStop', (me) => {
        this.debug('scanning stopped by %s', me ? 'me' : 'someone else')
      })
      .on('shadeFound', async (device) => {
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
            onDeviceFound: () => {}
          }
          this.log(
            '%s: currentPosition %d%%', device.data.displayName,
            device.data.currentPosition
          )
          this.log(
            '%s: targetPosition %d%%', device.data.displayName,
            device.data.targetPosition
          )
          this.log(
            '%s: currentPosition %d%%', device.data.displayName,
            device.data.currentPosition
          )
          this.log(
            '%s: battery %d%%', device.data.displayName,
            device.data.battery
          )
          const delegate = this.createDelegate(device.peripheral)
          try {
            const params = {
              id: (await delegate.getShadeMacAddress()).replace(/-/g, ''),
              deviceId: device.id,
              name: await delegate.getShadeName(),
              model: await delegate.getHardwareRevision(),
              firmware: await delegate.getSoftwareRevision(),
              supportsUp: await delegate.getVenetianMode(),
              triggers: await delegate.getTriggers()
            }
            this.debug('%s: %j', device.data.displayName, params)
            this.shades[device.id] = new SomaAccessory(this, params)
          } catch (error) {
            if (!(error instanceof SomaClient.BleError)) {
              this.error('%s: %s', device.id, error)
            }
            delete this.shades[device.id]
            return
          } finally {
            try {
              await delegate.disconnect()
            } catch (error) {
              if (!(error instanceof SomaClient.BleError)) {
                this.error('%s: %s', device.id, error)
              }
            }
            delegate.removeAllListeners()
          }
        }
        this.shades[device.id].onDeviceFound(device)
      })
  }

  createDelegate (peripheral, bleError = true) {
    const delegate = new SomaClient.SomaPeripheral(this.client, peripheral)
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
          this.vvdebug(
            '%s: request %d: response buffer: %j', delegate.id,
            response.request.id, bufferToHex(response.buffer)
          )
        }
      })
      .on('connected', () => { this.debug('%s: connected', delegate.id) })
      .on('disconnected', () => { this.debug('%s: disconnected', delegate.id) })
    return delegate
  }

  accessoryRestored (className, version, id, name, context) {
    switch (className) {
      case 'SomaAccessory':
        this.shades[context.deviceId] = new SomaAccessory(this, context)
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
