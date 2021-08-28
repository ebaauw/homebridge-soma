// homebridge-soma/lib/SomaAccessory.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const SomaClient = require('./SomaClient')
const SomaService = require('./SomaService')

const { bufferToHex } = require('../lib/BleUtils')

class SomaAccessory extends homebridgeLib.AccessoryDelegate {
  constructor (platform, params) {
    params.category = platform.platform.Accessory.Categories.WINDOW_COVERING
    super(platform, {
      id: params.id,
      name: params.name,
      category: params.category,
      manufacturer: 'SOMA Smart Home',
      model: params.model,
      firmware: params.firmware
    })
    this.context.id = params.id
    this.context.deviceId = params.deviceId
    this.context.name = params.name
    this.context.model = params.model
    this.context.firmware = params.firmware
    this.context.supportsUp = params.supportsUp

    this.service = new SomaService.WindowCovering(this, {
      supportsUp: params.supportsUp
    })
    this.lightSensorService = new SomaService.LightSensor(this)
    this.batteryService = new homebridgeLib.ServiceDelegate.Battery(this)
  }

  onDeviceFound (device) {
    this.vdebug('advertisement: %j', device.data)
    if (this.client == null) {
      this.client = new SomaClient.SomaPeripheral(
        this.platform.client, device.peripheral
      )
      this.client
        .on('error', (error) => {
          if (error instanceof SomaClient.BleError) {
            this.log('request %d: %s', error.request.id, error.request.request)
            this.warn('request %d: %s', error.request.id, error)
            return
          }
          this.warn('%s', error)
        })
        .on('request', (request) => {
          this.debug('request %d: %s', request.id, request.request)
        })
        .on('response', (response) => {
          if (response.parsedValue == null) {
            this.debug(
              'request %d: %s: ok', response.request.id, response.request.request
            )
          } else {
            this.debug(
              'request %d: %s: response: %j', response.request.id,
              response.request.request, response.parsedValue
            )
          }
          if (response.buffer != null) {
            this.vdebug(
              'request %d: response buffer: %j',
              response.request.id, bufferToHex(response.buffer)
            )
          }
        })
      this.heartbeatEnabled = true
      this
        .once('heartbeat', (beat) => { this.initialBeat = beat })
        .on('heartbeat', this.heartbeat)
        .on('identify', this.identify)
      this.debug('initialised')
      this.emit('initialised')
    }
    this.name = device.data.displayName
    this.service.updatePosition(device.data.currentPosition)
    this.service.updateLastSeen()
    this.batteryService.values.batteryLevel = device.data.battery
  }

  async heartbeat (beat) {
    if ((beat - this.initialBeat) % 300 === 0) {
      try {
        const response = await this.client.read('shadeService', 'shadeState')
        const { chargingLevel } = response.parsedValue
        this.lightSensorService.values.currentAmbientLightLevel = chargingLevel
        this.batteryService.values.chargingState = chargingLevel > 50
          ? this.Characteristics.hap.ChargingState.CHARGING
          : this.Characteristics.hap.ChargingState.NOT_CHARGING
      } catch (error) {
        if (!(error instanceof SomaClient.BleError)) {
          this.error(error)
        }
      }
      try {
        await this.client.disconnect()
      } catch (error) {
        if (!(error instanceof SomaClient.BleError)) {
          this.error(error)
        }
      }
    }
  }

  async identify () {
    try {
      await this.client.write('motorService', 'motorNotify', Buffer.from([0x01]))
    } catch (error) {
      if (!(error instanceof SomaClient.BleError)) {
        this.error(error)
      }
    }
    try {
      await this.client.disconnect()
    } catch (error) {
      if (!(error instanceof SomaClient.BleError)) {
        this.error(error)
      }
    }
  }
}

module.exports = SomaAccessory
