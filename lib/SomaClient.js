// homebridge-soma/lib/SomaClient.js
// Copyright © 2021-2022 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

// const events = require('events')
const BleClient = require('./BleClient')

const {
  toHex // , bufferToHex //, bufferToManufacturer, nameToKey, uuidToString
} = require('./BleUtils.js')

const motorTriggerCommandCodes = {
  0x13: 'add',
  0x23: 'remove',
  0x33: 'read',
  0x43: 'edit',
  0x63: 'clearAll'
}
const motorTriggerCommands = {}
for (const key in motorTriggerCommandCodes) {
  motorTriggerCommands[motorTriggerCommandCodes[key]] = Number(key)
}

const motorTriggerStatusCodes = {
  0x30: 'success',
  0xF0: 'failed'
}
const motorTriggerStatus = {}
for (const key in motorTriggerStatusCodes) {
  motorTriggerStatus[motorTriggerStatusCodes[key]] = Number(key)
}

const motorCalibrationCommandCodes = {
  0xA8: 'venetianModeOn',
  0xA9: 'venetianModeOff',
  0xAA: 'queryVenetianMode'
}
const motorCalibrationCommands = {}
for (const key in motorCalibrationCommandCodes) {
  motorCalibrationCommands[motorCalibrationCommandCodes[key]] = Number(key)
}

const motorControlCommandCodes = {
  0x00: 'stop',
  0x01: 'stopAtNextStep',
  0x68: 'stepUp',
  0x69: 'up',
  0x86: 'stepDown',
  0x96: 'down',
  0xFF: 'lowBattery'
}
const motorControlCommands = {}
for (const key in motorControlCommandCodes) {
  motorControlCommands[motorControlCommandCodes[key]] = Number(key)
}

const shadeControlCommands = {
  0x51: 'factoryReset',
  0x71: 'restart',
  0xC1: 'firmwareUpgrade',
  0xA1: 'discoveryMode',
  0xAC: 'clearWhitelist',
  0xAD: 'whitelistMode',
  0xB1: 'disconnect',
  0xD1: 'deepSleep'
}
const shadeControlCommandNames = {}
for (const key in shadeControlCommands) {
  shadeControlCommandNames[shadeControlCommands[key]] = Number(key)
}

const shadeConfigCommandCodes = {
  0x01: 'motorSpeed',
  0x02: 'motorDirection',
  0x03: 'motorSpeedTrigger',
  0x04: 'pid',
  0x05: 'geoPosition',
  0x06: 'localTimeOffset',
  0x07: 'motorAcceleration',
  0x08: 'motorDeceleration',
  0x09: 'motorUstallAcceleration',
  0x0A: 'increaseEncoderBy2',
  0x0B: 'increaseEncoderBy4',
  0x0C: 'bootSeq',
  0x0D: 'resetReason',
  0x0E: 'stopReason',
  0x0F: 'pofCount',
  0x10: 'slipLength',
  0x11: 'encMax',
  0x12: 'encCur',
  0x13: 'slipInterval',
  0x14: 'positionMoveTotal',
  0x15: 'motorMoveTotal',
  0x16: 'inCalibrationMode',
  0x17: 'sunriseSunset',
  0x18: 'motorCurrent',
  0xFF: 'query'
}
const shadeConfigCommands = {}
for (const key in shadeConfigCommandCodes) {
  shadeConfigCommands[shadeConfigCommandCodes[key]] = Number(key)
}

/** Parse a null-terminated string.
  * @returns {string} - The string.
  */
function parseCString (buffer) {
  let s = buffer.toString()
  s = s.slice(0, s.indexOf('\0')).trim()
  if (/^.*[^0-9 ]0$/.test(s)) {
    s = s.slice(0, -1)
  }
  return s
}

/** Parse a date, localtime in seconds since epoch.
  * @returns {string} - ISO string for date, with second precision
  */
function parseDate (buffer, offset = 0) {
  return new Date(buffer.readUInt32LE(offset) * 1000).toISOString().slice(0, -5)
}

function parseTrigger (buffer, offset = 0) {
  const flags = buffer.readUInt8(offset + 6)
  const result = {}
  const weekdays = buffer.readUInt8(offset + 4)
  if ((weekdays & 0x7F) === 0x7F) {
    result.trigger = 'Every Day'
  } else {
    const days = []
    if ((weekdays & 0x02) !== 0) days.push('Mon')
    if ((weekdays & 0x04) !== 0) days.push('Tue')
    if ((weekdays & 0x08) !== 0) days.push('Wed')
    if ((weekdays & 0x10) !== 0) days.push('Thu')
    if ((weekdays & 0x20) !== 0) days.push('Fri')
    if ((weekdays & 0x40) !== 0) days.push('Sat')
    if ((weekdays & 0x01) !== 0) days.push('Sun')
    result.trigger = days.join(' ')
  }
  if ((flags & 0x04) !== 0) {
    result.trigger += ' at ' + ((flags & 0x02) !== 0 ? 'Sunset' : 'Sunrise')
    const sunOffset = buffer.readInt32LE(offset)
    if (sunOffset < 0) {
      result.trigger += ' -' +
        new Date(sunOffset * -1000).toISOString().slice(12, 16)
    } else if (sunOffset > 0) {
      result.trigger += ' +' +
        new Date(sunOffset * 1000).toISOString().slice(12, 16)
    }
  } else if ((flags & 0x02) !== 0) {
    const lightlevel = buffer.readInt32LE(offset)
    if (lightlevel > 0) {
      result.trigger += ' when Light Level > ' + lightlevel
    } else {
      result.trigger += ' when Light Level < ' + lightlevel * -1
    }
  } else {
    result.trigger += ' at ' + parseDate(buffer, offset).slice(11, 16)
  }
  result.position = buffer.readUInt8(offset + 5)
  result.morningMode = (flags & 0x80) !== 0
  result.enabled = (flags & 0x01) !== 0
  return result
}

const uuidDefinitions = {
  '00001554-B87F-490C-92CB-11BA5EA5167C': {
    name: 'Time Service',
    characteristics: {
      '00001555-B87F-490C-92CB-11BA5EA5167C': { // read, write, notify
        name: 'Local Time',
        f: parseDate
      }
    }
  },
  '00001861-B87F-490C-92CB-11BA5EA5167C': {
    name: 'Motor Service',
    characteristics: {
      '00001525-B87F-490C-92CB-11BA5EA5167C': { // read, notify
        name: 'Motor Current State',
        f: (b) => {
          const triggers = []
          for (let i = 0; i < 16; i++) {
            const id = b.readUint16LE(2 * i + 1)
            if (id !== 0) {
              triggers.push(id)
            }
          }
          return {
            position: b.readUInt8(0),
            triggers: triggers
          }
        }
      },
      '00001526-B87F-490C-92CB-11BA5EA5167C': { // read, write
        name: 'Motor Target State',
        f: b => b.readUInt8()
      },
      '00001527-B87F-490C-92CB-11BA5EA5167C': {
        name: 'Motor Trigger Request', // read, write
        f: b => {
          const command = b.readUInt8(0)
          const result = {
            command: motorTriggerCommandCodes[command] == null
              ? toHex(command)
              : motorTriggerCommandCodes[command],
            id: b.readUInt16LE(1)
          }
          if (
            command === motorTriggerCommands.add ||
            command === motorTriggerCommands.edit
          ) {
            Object.assign(result, parseTrigger(b, 3))
          }
          return result
        }
      },
      '00001528-B87F-490C-92CB-11BA5EA5167C': {
        name: 'Motor Trigger Response', // read, notify
        f: b => {
          const status = b.readUInt8(0)
          const command = b.readUInt8(1)
          const result = {
            status: motorTriggerStatusCodes[status] == null
              ? toHex(status)
              : motorTriggerStatusCodes[status],
            command: motorTriggerCommandCodes[command] == null
              ? toHex(command)
              : motorTriggerCommandCodes[command]
          }
          if (
            status === motorTriggerStatus.success &&
            command === motorTriggerCommands.read
          ) {
            result.id = b.readUInt16LE(2)
            Object.assign(result, parseTrigger(b, 4))
          }
          return result
        }
      },
      '00001529-B87F-490C-92CB-11BA5EA5167C': { // read, write, notify
        name: 'Motor Calibration',
        f: b => {
          const value = b.readUInt8()
          const result = {}
          if (value === motorCalibrationCommands.venetianModeOn) {
            result.venetianMode = true
          } else if (value === motorCalibrationCommands.venetianModeOff) {
            result.venetianMode = false
          } else {
            result.rawValue = toHex(value)
          }
          return result
        }
      },
      '00001530-B87F-490C-92CB-11BA5EA5167C': { // read, write
        name: 'Motor Control',
        f: b => toHex(b.readUInt8())
      },
      '00001531-B87F-490C-92CB-11BA5EA5167C': { // read, write
        name: 'Motor Notify',
        f: b => b.readUInt8() !== 0
      },
      '00001532-B87F-490C-92CB-11BA5EA5167C': { // read
        name: 'Motor Solar Panel Voltage',
        f: b => b.readUInt16LE()
      },
      '00001533-B87F-490C-92CB-11BA5EA5167C': { // read, write
        name: 'Motor Touch Button Enabled',
        f: b => b.readUInt8() !== 0
      },
      '00001534-B87F-490C-92CB-11BA5EA5167C': { // read, write
        name: 'Motor Speed',
        f: b => b.readUInt8()
      },
      '0000BA71-B87F-490C-92CB-11BA5EA5167C': { // read, notify
        name: 'Motor Battery Level',
        f: b => b.readUInt16LE()
      },
      '0000BA72-B87F-490C-92CB-11BA5EA5167C': { // read, notify
        name: 'Motor Under Voltage',
        f: b => b.readUInt8() !== 0
      }
    }
  },
  '00001890-B87F-490C-92CB-11BA5EA5167C': {
    name: 'Shade Service',
    characteristics: {
      '00001891-B87F-490C-92CB-11BA5EA5167C': { // read, write, indicate
        name: 'Shade Control',
        f: b => toHex(b.readUInt8())
      },
      '00001892-B87F-490C-92CB-11BA5EA5167C': { // read, write
        name: 'Shade Name',
        f: parseCString
      },
      '00001893-B87F-490C-92CB-11BA5EA5167C': { // read, write
        name: 'Group Name',
        f: parseCString
      },
      '00001894-B87F-490C-92CB-11BA5EA5167C': { // read, notify
        name: 'Shade State',
        f: b => {
          return {
            chargingLevel: b.readUInt16LE(0), // This is also the light level.
            panelLevel: b.readUInt16LE(2)
          }
        }
      },
      '00001895-B87F-490C-92CB-11BA5EA5167C': { // read
        name: 'Shade Mac Address',
        f: b => b.toString().trim()
      },
      '00001896-B87F-490C-92CB-11BA5EA5167C': { // read, write, notify
        name: 'Shade Config',
        f: b => {
          const result = {}
          let offset = 0
          const command = b.readUInt8(offset++)
          const length = b.readUInt8(offset++)
          switch (command) {
            case shadeConfigCommands.query:
              for (let offset = 2; offset < length;) {
                const command = b.readUInt8(offset++)
                const length = b.readUInt8(offset++)
                switch (command) {
                  case shadeConfigCommands.motorSpeed:
                    if (length === 1) {
                      result.motorSpeed = b.readUInt8(offset)
                    }
                    break
                  case shadeConfigCommands.localTimeOffset:
                    if (length === 1) {
                      result.localTimeOffset = b.readInt8(offset) * -60
                    }
                    break
                  case shadeConfigCommands.bootSeq:
                    if (length === 4) {
                      result.bootSeq = b.readUInt32LE(offset)
                    }
                    break
                  case shadeConfigCommands.sunriseSunset:
                    if (length === 8) {
                      result.sunrise = parseDate(b, offset).slice(0, -3)
                      result.sunset = parseDate(b, offset + 4).slice(0, -3)
                    }
                    break
                  default:
                    break
                }
                offset += length
              }
              break
            default:
              break
          }
          return result
        }
      }
    }
  }
}

function parseManufacturerData (buffer) {
  const result = {
    advDataProtocol: buffer.readUInt8(2),
    battery: buffer.readUInt8(3),
    venetianMode: false,
    currentPosition: buffer.readUInt8(4),
    targetPosition: buffer.readUInt8(5),
    displayName: parseCString(buffer.slice(6))
  }
  if (result.battery & 0x80) {
    result.battery &= 0x7F
    result.venetianMode = true
    result.currentPosition *= 2
    result.currentPosition -= 100
    result.targetPosition *= 2
    result.targetPosition -= 100
  }
  return result
}

class SomaClient extends BleClient {
  static get SomaPeripheral () { return SomaPeripheral }

  constructor (params = {}) {
    params.allowDuplicates = true
    super(params)
    this.on('deviceFound', (device) => {
      if (device.manufacturer != null && device.manufacturer.code === '0370') {
        device.data = parseManufacturerData(device.manufacturerData)
        /** Emitted when a shade has been found.
          * @event SomaClient#shadeFound
          * @param {Device} device
          */
        this.emit('shadeFound', device)
      }
    })
  }
}

/** Delegate class for a Soma Peripheral.
  */
class SomaPeripheral extends BleClient.BlePeripheralDelegate {
  /** Create a new peripheral delegate.
    * @param {Device} device
    */
  constructor (client, device) {
    super(client, device.peripheral, uuidDefinitions)
    this._venetianMode = device.data.venetianMode
  }

  get venetianMode () { return this._venetianMode }

  /* ===== Device Information =============================================== */

  async getManufacturerName () {
    return (await this.read(
      'deviceInformation', 'manufacturerName'
    )).parsedValue
  }

  async getHardwareRevision () {
    return (await this.read(
      'deviceInformation', 'hardwareRevision'
    )).parsedValue
  }

  async getSoftwareRevision () {
    return (await this.read(
      'deviceInformation', 'softwareRevision'
    )).parsedValue.slice(1)
  }

  /* ===== Time Service ===================================================== */

  async getLocalTime () {
    return (await this.read('timeService', 'localTime')).parsedValue
  }

  async setLocalTime () {
    const buffer = Buffer.alloc(4)
    const now = new Date()
    let value = Math.round(now.valueOf() / 1000)
    value -= now.getTimezoneOffset() * 60
    buffer.writeUInt32LE(value)
    return this.write('timeService', 'localTime', buffer)
  }

  /* ===== Motor Service ==================================================== */

  async getTriggers () {
    return (await this.read(
      'motorService', 'motorCurrentState'
    )).parsedValue.triggers
  }

  async setPosition (position) {
    return this.write(
      'motorService', 'motorTargetState', Buffer.from([position])
    )
  }

  async getTrigger (id) {
    const buffer = Buffer.alloc(17, 0x37)
    buffer.writeUInt8(motorTriggerCommands.read, 0)
    buffer.writeUInt16LE(id, 1)
    await this.subscribe('motorService', 'motorTriggerResponse')
    await this.write('motorService', 'motorTriggerRequest', buffer)
    return (await this.notification(
      'motorService', 'motorTriggerResponse'
    )).response[0].parsedValue
  }

  async setTriggerEnabled (id, enabled) {
    const response = await this.getTrigger(id)
    const buffer = Buffer.alloc(17, 0x37)
    buffer.writeUInt8(motorTriggerCommands.edit, 0)
    buffer.writeUInt16LE(id, 1)
    buffer.writeUInt32LE(response.buffer.readUInt32LE(4), 3) // timestamp
    buffer.writeUInt8(response.buffer.readUInt8(8), 7) // weekdays
    buffer.writeUInt8(response.buffer.readUInt8(9), 8) // position
    let flags = response.buffer.readUInt8(10)
    if (enabled) {
      flags |= 0x01
    } else {
      flags &= ~0x01
    }
    buffer.writeUInt8(flags, 9)
    await this.write('motorService', 'motorTriggerRequest', buffer)
    return (await this.getTrigger(id)).parsedValue
  }

  async getVenetianMode () {
    await this.subscribe('motorService', 'motorCalibration')
    await this.write(
      'motorService', 'motorCalibration',
      Buffer.from([motorCalibrationCommandCodes.queryVenetianMode])
    )
    return (await this.notification(
      'motorService', 'motorCalibration'
    )).result[0].parsedValue.venetianMode
  }

  async _setMotorControl (command) {
    return this.write(
      'motorService', 'motorControl', Buffer.from([command])
    )
  }

  async up () {
    return this._setMotorControl(motorControlCommands.up)
  }

  async down () {
    return this._setMotorControl(motorControlCommands.down)
  }

  async stop () {
    return this._setMotorControl(motorControlCommands.stop)
  }

  async stepUp () {
    return this._setMotorControl(motorControlCommands.stepUp)
  }

  async stepDown () {
    return this._setMotorControl(motorControlCommands.stepDown)
  }

  async stopAtNextStep () {
    return this._setMotorControl(motorControlCommands.stopAtNextStep)
  }

  async notify () {
    return this.write('motorService', 'motorNotify', Buffer.from([0x01]))
  }

  /* ===== Shade Service ==================================================== */

  async restart () {
    return this.write(
      'shadeService', 'shadeControl',
      Buffer.from([shadeControlCommandNames.restart])
    )
  }

  async getShadeName () {
    return (await this.read('shadeService', 'shadeName')).parsedValue
  }

  async getShadeMacAddress () {
    return (await this.read('shadeService', 'shadeMacAddress')).parsedValue
  }

  async getShadeState () {
    return (await this.read('shadeService', 'shadeState')).parsedValue
  }

  async _getShadeConfig (commands) {
    await this.subscribe('shadeService', 'shadeConfig')
    commands.unshift(shadeConfigCommands.query, commands.length & 0xFF)
    await this.write(
      'shadeService', 'shadeConfig', Buffer.from(commands)
    )
    return (await this.notification(
      'shadeService', 'shadeConfig'
    )).response[0].parsedValue
  }

  async getShadeConfig () {
    return this._getShadeConfig([
      shadeConfigCommands.motorSpeed,
      shadeConfigCommands.localTimeOffset,
      shadeConfigCommands.bootSeq
    ])
  }

  async getSunriseSunset () {
    return this._getShadeConfig([shadeConfigCommands.sunriseSunset])
  }

  async setMotorSpeed (speed) {
    return this.write(
      'shadeService', 'shadeConfig',
      Buffer.from([shadeConfigCommands.motorSpeed, 0x01, speed & 0xFF])
    )
  }

  async setLocalTimeOffset () {
    const buffer = Buffer.from([
      shadeConfigCommands.localTimeOffset, 0x01, 0x00
    ])
    buffer.writeInt8(Math.round((new Date()).getTimezoneOffset() / -60), 2)
    return this.write('shadeService', 'shadeConfig', buffer)
  }
}

module.exports = SomaClient
