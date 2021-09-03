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
    if (this.context.triggers == null) {
      this.context.triggers = {}
    }

    this.service = new SomaService.WindowCovering(this, {
      supportsUp: params.supportsUp
    })
    // FIXME: light sensor in separate accessory - Home doesn't like
    // actuator- and sensor-servcies in the same accessory
    this.lightSensorService = new SomaService.LightSensor(this)
    this.batteryService = new homebridgeLib.ServiceDelegate.Battery(this)
    this.triggerServices = {}
    for (const id in this.context.triggers) {
      this.triggerServices[id] = new SomaService.Trigger(
        this, this.context.triggers[id]
      )
    }
  }

  async onDeviceFound (device) {
    this.vdebug('advertisement: %j', device.data)
    this.name = device.data.displayName
    this.service.updatePosition(device.data.currentPosition)
    this.service.updateLastSeen()
    this.batteryService.values.batteryLevel = device.data.battery
    if (this.client == null) {
      this.client = new SomaClient.SomaPeripheral(
        this.platform.client, device.peripheral
      )
      this.client
        .on('error', (error) => {
          if (/* error instanceof SomaClient.BleError && */ error.request != null) {
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
        .on('connected', () => { this.debug('connected') })
        .on('disconnected', () => { this.debug('disconnected') })
        .on('notification', (notification) => {
          this.debug(
            'notification: %s/%s: %s', notification.serviceKey,
            notification.key, bufferToHex(notification.buffer)
          )
          this.debug(
            'notification: %s/%s: %j', notification.serviceKey,
            notification.key, notification.parsedValue
          )
        })
      this
        .on('identify', this.identify)
      try {
        await this.heartbeat()
      } finally {
        this.debug('initialised')
        this.emit('initialised')
      }
    }
  }

  async heartbeat () {
    try {
      if (this.client == null) {
        return
      }
      const { chargingLevel } = await this.client.getShadeState()
      this.lightSensorService.values.currentAmbientLightLevel = chargingLevel
      this.lightSensorService.values.lastUpdated =
        (new Date()).toString().slice(0, 24)
      this.batteryService.values.chargingState = chargingLevel > 50
        ? this.Characteristics.hap.ChargingState.CHARGING
        : this.Characteristics.hap.ChargingState.NOT_CHARGING
      const { sunrise, sunset } = await this.client.getSunriseSunset()
      this.lightSensorService.values.sunrise = new Date(sunrise).toString().slice(0, 21)
      this.lightSensorService.values.sunset = new Date(sunset).toString().slice(0, 21)
      const triggers = await this.client.getTriggers()
      const foundTriggers = {}
      for (const id of triggers) {
        const trigger = (await this.client.getTrigger(id))
        foundTriggers[id] = true
        this.context.triggers[id] = trigger
        if (this.triggerServices[id] == null) {
          this.triggerServices[id] = new SomaService.Trigger(this, trigger)
        } else {
          this.triggerServices[id].update(trigger)
        }
      }
      for (const id in this.triggerServices) {
        if (foundTriggers[id] == null) {
          this.triggerServices[id].destroy()
          delete this.triggerServices[id]
          delete this.context.triggers[id]
        }
      }
      this.debug('triggers: %j', this.context.triggers)
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

  async identify () {
    try {
      await this.client.notify()
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
