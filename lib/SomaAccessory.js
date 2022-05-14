// homebridge-soma/lib/SomaAccessory.js
// Copyright © 2021-2022 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const SomaClient = require('./SomaClient')
const SomaService = require('./SomaService')
const packageJson = require('../package.json')

const { bufferToHex } = require('../lib/BleUtils')

class SomaAccessory extends homebridgeLib.AccessoryDelegate {
  constructor (platform, params) {
    params.category = platform.platform.Accessory.Categories.WINDOW_COVERING
    let model = params.venetianMode ? 'Tilt' : 'Smart Shades'
    if (params.hardware.startsWith('BLINDY_V9')) {
      model += ' 2'
    }
    super(platform, {
      id: params.id,
      name: params.name,
      category: params.category,
      manufacturer: 'SOMA Smart Home',
      model,
      firmware: params.firmware,
      hardware: params.hardware
    })
    this.revision = params.hardware === 'BLINDY_V9_6' ? 'soma_6' : 'soma'
    this.context.id = params.id
    this.context.deviceId = params.deviceId
    this.context.address = params.address
    this.context.name = params.name
    this.context.model = model
    this.context.firmware = params.firmware
    this.context.hardware = params.hardware
    this.context.venetianMode = params.venetianMode
    if (this.context.triggers == null) {
      this.context.triggers = {}
    }

    this.service = new SomaService.WindowCovering(this, {
      venetianMode: params.venetianMode
    })
    this.manageLogLevel(this.service.characteristicDelegate('logLevel'))
    this.batteryService = new homebridgeLib.ServiceDelegate.Battery(this)
    this.triggerServices = {}
    for (const id in this.context.triggers) {
      this.triggerServices[id] = new SomaService.Trigger(
        this, this.context.triggers[id]
      )
    }

    this.rebooted = true
    this.notYetInitialised = true
    this.pollingStage = 0
  }

  async onDeviceFound (device) {
    this.vdebug('advertisement: rssi: %s, data: %j', device.peripheral.rssi, device.data)
    if (this.service.values.restart) {
      return
    }
    this.name = device.data.displayName
    this.service.updatePosition(device.data.currentPosition)
    this.service.updateLastSeen()
    this.batteryService.values.batteryLevel = device.data.battery
    if (this.client == null) {
      this.client = new SomaClient.SomaPeripheral(this.platform.client, device)
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
        .on('connected', (rssi) => {
          this.debug('connected (rssi: %d)', rssi)
          this.service.values.rssi = rssi
        })
        .on('disconnected', () => { this.debug('disconnected') })
        .on('notification', (notification) => {
          this.vdebug(
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
      this.pollNext = true
    }
  }

  async heartbeat (beat) {
    try {
      if (this.pollNext) {
        this.initialBeat = beat
        this.pollNext = false
      }
      if ((beat - this.initialBeat) % (this.service.values.heartrate * 60) !== 0) {
        return
      }
      if (this.pollingStage === 0) {
        this.log('polling')
      } else {
        this.log('resume polling at stage %d', this.pollingStage)
      }

      let now = new Date()
      if (this.pollingStage < 1) {
        const { chargingLevel } = await this.client.getShadeState()
        this.service.values.currentAmbientLightLevel = chargingLevel
        this.service.values.lastUpdated = now.toString().slice(0, 24)
        this.batteryService.values.chargingState = chargingLevel > 50
          ? this.Characteristics.hap.ChargingState.CHARGING
          : this.Characteristics.hap.ChargingState.NOT_CHARGING
        this.pollingStage = 1
      }

      if (this.pollingStage < 2) {
        const {
          motorSpeed, localTimeOffset, bootSeq
        } = await this.client.getShadeConfig()
        this.service.values.restart = false
        this.service.values.bootSeq = bootSeq
        this.service.values.motorSpeed = motorSpeed
        if (this.rebooted) {
          this.values.firmware = await this.client.getSoftwareRevision()
          this.context.firmware = this.values.firmware
          if (this.values.firmware !== packageJson.engines[this.revision]) {
            this.warn(
              'recommended version: %s v%s',
              this.values.model, packageJson.engines.soma
            )
          }
          this.rebooted = false
        }
        if (localTimeOffset !== now.getTimezoneOffset()) {
          this.log(
            'update device timezone from %d to %d',
            localTimeOffset, now.getTimezoneOffset()
          )
          await this.client.setLocalTimeOffset()
          delete this.today // force re-read of sunrise/sunset
        }
        this.pollingStage = 2
      }

      if (this.pollingStage < 3) {
        const deviceTime = new Date(await this.client.getLocalTime())
        now = new Date()
        const delta = Math.floor(deviceTime / 1000) - Math.floor(now / 1000)
        if (delta <= -5 || delta >= 5) {
          this.log(
            'update device clock from %s to %s',
            deviceTime.toTimeString().slice(0, 8), now.toTimeString().slice(0, 8)
          )
          await this.client.setLocalTime()
        }
        this.pollingStage = 3
      }

      if (this.pollingStage < 4) {
        if (now.toDateString() !== this.today) {
          const { sunrise, sunset } = await this.client.getSunriseSunset()
          const sunriseDate = new Date(sunrise)
          const sunsetDate = new Date(sunset)
          this.service.values.sunrise = sunriseDate.toString().slice(0, 21)
          this.service.values.sunset = sunsetDate.toString().slice(0, 21)
          this.today = sunriseDate.toDateString()
        }
        this.pollingStage = 4
      }

      if (this.pollingStage < 5) {
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
        this.pollingStage = 5
      }

      if (this.notYetInitialised) {
        this.debug('initialised')
        this.emit('initialised')
        this.notYetInitialised = false
      }
      this.pollingStage = 0
      this.log('polling: ok')
    } catch (error) {
      if (!(error instanceof SomaClient.BleError)) {
        this.error(error)
      }
      this.warn('polling: failed at stage', this.pollingStage)
      setTimeout(() => { this.pollNext = true }, 5000)
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
      this.pollNext = true
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
