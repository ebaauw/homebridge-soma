// homebridge-soma/lib/SomaService.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const SomaClient = require('./SomaClient')

class SomaService extends homebridgeLib.ServiceDelegate {
  static get WindowCovering () { return WindowCovering }
  static get LightSensor () { return LightSensor }
}

class WindowCovering extends homebridgeLib.ServiceDelegate {
  constructor (accessory, params = {}) {
    params.name = accessory.name
    params.Service = accessory.Services.hap.WindowCovering
    params.primaryService = true
    super(accessory, params)
    this.accessory = accessory
    this.supportsUp = params.supportsUp

    this.addCharacteristicDelegate({
      key: 'currentPosition',
      Characteristic: this.Characteristics.hap.CurrentPosition,
      unit: '%',
      value: 100 // % open
    })
    this.addCharacteristicDelegate({
      key: 'targetPosition',
      Characteristic: this.Characteristics.hap.TargetPosition,
      unit: '%',
      value: 100 // % open
    }).on('didSet', async (value, fromHomeKit) => {
      if (!fromHomeKit) {
        return
      }
      this.values.targetPosition = Math.round(this.values.targetPosition / 5) * 5
      this.setShadePosition()
    })
    this.addCharacteristicDelegate({
      key: 'holdPosition',
      Characteristic: this.Characteristics.hap.HoldPosition
    }).on('didSet', async (value, fromHomeKit) => {
      if (!fromHomeKit) {
        return
      }
      try {
        await this.accessory.client.stop()
        this.moving = false
      } catch (error) {
        if (!(error instanceof SomaClient.BleError)) {
          this.error(error)
        }
      }
      try {
        await this.accessory.client.disconnect()
      } catch (error) {
        if (!(error instanceof SomaClient.BleError)) {
          this.error(error)
        }
      }
    })
    this.addCharacteristicDelegate({
      key: 'positionState',
      Characteristic: this.Characteristics.hap.PositionState,
      value: this.Characteristics.hap.PositionState.STOPPED
    })
    if (this.supportsUp) {
      this.addCharacteristicDelegate({
        key: 'closeUpwards',
        Characteristic: this.Characteristics.my.CloseUpwards,
        value: false
      }).on('didSet', async (value, fromHomeKit) => {
        if (!fromHomeKit) {
          return
        }
        this.setShadePosition()
      })
    }
    this.addCharacteristicDelegate({
      key: 'morningMode',
      Characteristic: this.Characteristics.my.MorningMode,
      value: false
    })
    this.addCharacteristicDelegate({
      key: 'position',
      value: 0
      // silent: true
    })
    this.addCharacteristicDelegate({
      key: 'lastSeen',
      Characteristic: this.Characteristics.my.LastSeen,
      silent: true
    })
    this.addCharacteristicDelegate({
      key: 'logLevel',
      Characteristic: this.Characteristics.my.LogLevel,
      value: accessory.platform.logLevel
    }).on('didSet', (value) => {
      accessory.logLevel = value
    })
    this.addCharacteristicDelegate({
      key: 'statusFault',
      Characteristic: this.Characteristics.hap.StatusFault,
      value: this.Characteristics.hap.StatusFault.GENERAL_FAULT
    })

    this.values.targetPosition = this.values.currentPosition
    this.values.positionState = this.Characteristics.hap.PositionState.STOPPED
  }

  setShadePosition () {
    if (this.timer != null) {
      clearTimeout(this.timer)
    }
    if (this.accessory.client == null) {
      return
    }
    this.timer = setTimeout(async () => {
      try {
        if (this.resetTimer != null) {
          clearTimeout(this.resetTimer)
          delete this.resetTimer
        }
        let position = 100 - this.values.targetPosition // % closed --> % open
        if (this.supportsUp) {
          if (this.values.closeUpwards) {
            position *= -1
          }
          position += 100
          position /= 2
          position &= 0xFF
          this.targetCloseUpwards = this.values.closeUpwards
        }
        if (position === this.values.position) {
          return
        }
        this.values.position = position
        this.values.positionState =
          this.values.targetPosition > this.values.currentPosition
            ? this.Characteristics.hap.PositionState.INCREASING
            : this.Characteristics.hap.PositionState.DECREASING
        await this.accessory.client.setPosition(position)
        this.moving = true
        this.resetTimer = setTimeout(() => {
          this.moving = false
          delete this.resetTimer
        }, 30000)
      } catch (error) {
        if (!(error instanceof SomaClient.BleError)) {
          this.error(error)
        }
      }
      try {
        await this.accessory.client.disconnect()
      } catch (error) {
        if (!(error instanceof SomaClient.BleError)) {
          this.error(error)
        }
      }
      delete this.timer
    }, 500)
  }

  updatePosition (position) {
    if (this.timer != null) {
      return
    }
    this.values.position = position
    let hkPosition = position
    let closeUpwards
    if (this.supportsUp) {
      hkPosition *= 2
      hkPosition -= 100
    }
    if (hkPosition < 2) {
      hkPosition *= -1
      closeUpwards = true
    } else if (hkPosition > 2) {
      closeUpwards = false
    }
    hkPosition = 100 - hkPosition // % open --> % closed
    hkPosition = Math.round(hkPosition / 5) * 5
    if (
      hkPosition === this.values.targetPosition &&
      (closeUpwards == null || closeUpwards === this.targetCloseUpwards)
    ) {
      this.moving = false
    }
    this.values.currentPosition = hkPosition
    if (closeUpwards != null) {
      this.values.closeUpwards = closeUpwards
    }
    if (!this.moving) {
      this.values.targetPosition = hkPosition
      this.values.positionState = this.Characteristics.hap.PositionState.STOPPED
    }
  }

  updateLastSeen () {
    this.values.statusFault = this.Characteristics.hap.StatusFault.NO_FAULT
    this.values.lastSeen = (new Date()).toString().slice(0, 21)
  }
}

class LightSensor extends homebridgeLib.ServiceDelegate {
  constructor (accessory, params = {}) {
    params.name = accessory.name
    params.Service = accessory.Services.hap.LightSensor
    super(accessory, params)
    this.accessory = accessory

    this.addCharacteristicDelegate({
      key: 'currentAmbientLightLevel',
      Characteristic: this.Characteristics.hap.CurrentAmbientLightLevel
    })
  }
}

module.exports = SomaService
