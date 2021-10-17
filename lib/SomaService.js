// homebridge-soma/lib/SomaService.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const SomaClient = require('./SomaClient')

class SomaService extends homebridgeLib.ServiceDelegate {
  static get WindowCovering () { return WindowCovering }
  static get Trigger () { return Trigger }
}

class WindowCovering extends homebridgeLib.ServiceDelegate {
  constructor (accessory, params = {}) {
    params.name = accessory.name
    params.Service = accessory.Services.hap.WindowCovering
    params.primaryService = true
    super(accessory, params)
    this.accessory = accessory
    this.venetianMode = params.venetianMode

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
    }).on('didSet', (value, fromHomeKit) => {
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
    if (this.venetianMode) {
      this.addCharacteristicDelegate({
        key: 'closeUpwards',
        Characteristic: this.Characteristics.my.CloseUpwards,
        value: false
      }).on('didSet', (value, fromHomeKit) => {
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
      key: 'motorSpeed',
      Characteristic: this.Characteristics.my.MotorSpeed,
      props: { minValue: 0, maxValue: 100, minStep: 1 },
      unit: '%',
      value: 100
    }).on('didSet', (value, fromHomeKit) => {
      if (!fromHomeKit) {
        return
      }
      this.setMotorSpeed()
    })
    this.addCharacteristicDelegate({
      key: 'currentAmbientLightLevel',
      Characteristic: this.Characteristics.hap.CurrentAmbientLightLevel
    })
    this.addCharacteristicDelegate({
      key: 'lastUpdated',
      Characteristic: this.Characteristics.my.LastUpdated
    })
    this.addCharacteristicDelegate({
      key: 'sunrise',
      Characteristic: this.Characteristics.my.Sunrise
    })
    this.addCharacteristicDelegate({
      key: 'sunset',
      Characteristic: this.Characteristics.my.Sunset
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
    this.addCharacteristicDelegate({
      key: 'heartrate',
      Characteristic: this.Characteristics.my.Heartrate,
      props: { unit: 'min', minValue: 1, maxValue: 30 },
      value: 5
    })
    this.addCharacteristicDelegate({
      key: 'bootSeq'
    }).on('didSet', (value) => {
      this.accessory.rebooted = true
    })
    this.addCharacteristicDelegate({
      key: 'restart',
      Characteristic: this.Characteristics.my.Restart,
      value: false
    }).on('didSet', async (value, fromHomeKit) => {
      if (!fromHomeKit || !value || this.accessory.client == null) {
        return
      }
      try {
        delete this.accessory.initialBeat // disable heartbeat
        this.accessory.pollNext = false
        try {
          await this.accessory.client.restart()
        } catch (error) {
          if (
            !(error instanceof SomaClient.BleError) &&
            error.message !== 'disconnected unexpectedly'
          ) {
            throw error
          }
        }
        await homebridgeLib.timeout(5000)
        this.accessory.pollNext = true
      } catch (error) {
        if (!(error instanceof SomaClient.BleError)) {
          this.error(error)
        }
      }
    })
    this.addCharacteristicDelegate({
      key: 'rssi',
      Characteristic: this.Characteristics.hap.ReceivedSignalStrengthIndication
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
        if (this.venetianMode) {
          if (this.values.closeUpwards) {
            position *= -1
          }
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
        if (this.venetianMode) {
          position += 100
          position /= 2
          position &= 0xFF
        }
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

  setMotorSpeed () {
    if (this.timer != null) {
      clearTimeout(this.timer)
    }
    if (this.accessory.client == null) {
      return
    }
    this.timer = setTimeout(async () => {
      try {
        await this.accessory.client.setMotorSpeed(this.values.motorSpeed)
      } catch (error) {
        if (!(error instanceof SomaClient.BleError)) {
          this.error(error)
        }
      }
    }, 500)
  }

  updatePosition (position) {
    if (this.timer != null) {
      return
    }
    this.values.position = position
    let hkPosition = Math.round(position / 5) * 5
    let closeUpwards
    if (this.venetianMode) {
      if (hkPosition < 0) {
        hkPosition *= -1
        closeUpwards = true
      } else if (hkPosition > 0) {
        closeUpwards = false
      }
    }
    hkPosition = 100 - hkPosition // % open --> % closed
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

class Trigger extends homebridgeLib.ServiceDelegate {
  constructor (accessory, trigger) {
    super(accessory, {
      name: accessory.name + ' Trigger ' + trigger.id,
      Service: accessory.Services.my.Resource,
      subtype: 'T' + trigger.id
    })
    this.accessory = accessory

    this.addCharacteristicDelegate({
      key: 'enabled',
      Characteristic: this.Characteristics.my.Enabled,
      value: trigger.enabled
    }).on('didSet', async (value, fromHomeKit) => {
      if (!fromHomeKit) {
        return
      }
      await this.setEnabled(trigger.id, value)
    })
    this.addCharacteristicDelegate({
      key: 'resource',
      Characteristic: this.Characteristics.my.Resource,
      value: trigger.trigger
    })
  }

  update (trigger) {
    this.values.resource = trigger.trigger
    this.values.enabled = trigger.enabled
  }

  async setEnabled (id, value) {
    try {
      const trigger = await this.accessory.client.setTriggerEnabled(id, value)
      this.update(trigger)
      this.accessory.context.triggers[id] = trigger
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
  }
}

module.exports = SomaService
