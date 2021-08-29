// homebridge-soma/lib/SomaClient.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const BleClient = require('./BleClient')

const {
  toHex, bufferToHex //, bufferToManufacturer, nameToKey, uuidToString
} = require('./BleUtils.js')

const motorControlCommands = {
  0x00: 'stop',
  0x01: 'stopAtNextStep',
  0x68: 'stepUp',
  0x69: 'up',
  0x86: 'stepDown',
  0x96: 'down',
  0xFF: 'lowBattery'
}

const motorControlCommandNames = {}
for (const key in motorControlCommands) {
  motorControlCommandNames[motorControlCommands[key]] = key
}

const triggerCommands = {
  0x13: 'add',
  0x23: 'remove',
  0x33: 'read',
  0x43: 'edit',
  0x63: 'clearAll'
}
const triggerCommandNames = {}
for (const key in triggerCommands) {
  triggerCommandNames[triggerCommands[key]] = key
}

const triggerStatus = {
  0x30: 'success',
  0xF0: 'failed'
}

function parseCString (buffer) {
  let s = buffer.toString()
  s = s.slice(0, s.indexOf('\0')).trim()
  if (/^.*[^0-9 ]0$/.test(s)) {
    s = s.slice(0, -1)
  }
  return s
}

function parseDate (buffer) {
  return (new Date(buffer.readUInt32LE() * 1000)).toISOString().slice(0, -5)
}

function parseTrigger (buffer) {
  const flags = buffer.readUInt8(6)
  const result = {
    flags: toHex(flags)
  }
  if ((flags & 0x04) !== 0) {
    result.trigger = (flags & 0x02) !== 0 ? 'sunset' : 'sunrise'
    result.offset = buffer.readInt32LE()
  } else if ((flags & 0x02) !== 0) {
    let lightlevel = buffer.readInt32LE()
    if (lightlevel > 0) {
      result.tigger = 'light level > ' + lightlevel
    } else {
      lightlevel *= -1
      result.trigger = 'light level < ' + lightlevel
    }
  } else {
    result.trigger = parseDate(buffer)
  }
  result.weekdays = toHex(buffer.readUInt8(4))
  result.position = buffer.readUInt8(5)
  result.morningMode = (flags & 0x80) !== 0
  result.enabled = (flags & 0x01) !== 0
  return result
}

const uuidDefinitions = {
  '00001554-B87F-490C-92CB-11BA5EA5167C': {
    name: 'Time Service',
    characteristics: {
      '00001555-B87F-490C-92CB-11BA5EA5167C': { // read, write, notify
        name: 'Current Time',
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
          const commandCode = b.readUInt8(0)
          const command = triggerCommands[commandCode] == null
            ? toHex(commandCode)
            : triggerCommands[commandCode]
          const result = {
            command: command,
            id: b.readUInt16LE(1)
          }
          if (command === 'add' || command === 'edit') {
            Object.assign(result, parseTrigger(b.slice(3)))
          }
          return result
        }
      },
      '00001528-B87F-490C-92CB-11BA5EA5167C': {
        name: 'Motor Trigger Response', // read, notify
        f: b => {
          const statusCode = b.readUInt8(0)
          const status = triggerStatus[statusCode] == null
            ? toHex(statusCode)
            : triggerStatus[statusCode]
          const commandCode = b.readUInt8(1)
          const command = triggerCommands[commandCode] == null
            ? toHex(commandCode)
            : triggerCommands[commandCode]
          const result = {
            status: status,
            command: command
          }
          if (status === 'success' && command === 'read') {
            result.id = b.readUInt16LE(2)
            Object.assign(result, parseTrigger(b.slice(4)))
          }
          return result
        }
      },
      '00001529-B87F-490C-92CB-11BA5EA5167C': { // read, write, notify
        name: 'Motor Calibration',
        f: b => {
          const value = b.readUInt8()
          const result = {}
          if (value === 0xA8) {
            result.venetianMode = true
          } else if (value === 0xA9) {
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
        name: 'Shade Firmware Control',
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
          return {
            restartReason: toHex(b.readUInt8(8)),
            bootSeq: b.readUInt8(9),
            motorSpeed: b.readUInt8(13),
            rawValue: bufferToHex(b)
          }
        }
      }
    }
  }
}

function parseManufacturerData (buffer) {
  return {
    advDataProtocol: toHex(buffer.readUInt8(2)),
    battery: buffer.readUInt8(3) & 0x7F,
    currentPosition: buffer.readUInt8(4),
    targetPosition: buffer.readUInt8(5),
    displayName: parseCString(buffer.slice(6))
  }
}

class SomaClient extends BleClient {
  static get SomaPeripheral () { return SomaPeripheral }

  constructor (params = {}) {
    params.allowDuplicates = true
    super(params)
    this.on('deviceFound', (device) => {
      if (device.manufacturer != null && device.manufacturer.code === '0370') {
        device.data = parseManufacturerData(device.manufacturerData)
        this.emit('shadeFound', device)
      }
    })
  }
}

/** Delegate class for a Soma Peripheral.
  */
class SomaPeripheral extends BleClient.BlePeripheralDelegate {
  /** Create a new peripheral delegate.
    * @param {Peripheral} peripheral
    */
  constructor (client, peripheral) {
    super(client, peripheral, uuidDefinitions)
  }

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

  async getCurrentTime () {
    return (await this.read('timeService', 'currentTime')).parsedValue
  }

  async setCurrentTime () {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(Math.round(new Date().valueOf() / 1000))
    return this.write('timeService', 'currentTime', buffer)
  }

  /* ===== Motor Service ==================================================== */

  async setPosition (position) {
    const buffer = Buffer.alloc(1)
    buffer.writeUInt8(position)
    return this.write('motorService', 'motorTargetState', buffer)
  }

  async _setMotorControl (command) {
    const buffer = Buffer.alloc(1)
    buffer.writeUInt8(triggerCommandNames[command])
    return this.write('motorService', 'motorControl', buffer)
  }

  async up () {
    return this._setMotorControl('up')
  }

  async down () {
    return this._setMotorControl('down')
  }

  async stop () {
    return this._setMotorControl('stop')
  }

  async stepUp () {
    return this._setMotorControl('stepUp')
  }

  async stepDown () {
    return this._setMotorControl('stepDown')
  }

  async stopAtNextStep () {
    return this._setMotorControl('stopAtNextStep')
  }

  async notify () {
    const buffer = Buffer.alloc(1)
    buffer.writeUInt8(0x01)
    return this.write('motorService', 'motorNotify', buffer)
  }

  async getTrigger (id) {
    const buffer = Buffer.alloc(17, 0x37)
    buffer.writeUInt8(triggerCommandNames.read, 0)
    buffer.writeUInt16LE(id, 1)
    await this.write('motorService', 'motorTriggerRequest', buffer)
    return this.read('motorService', 'motorTriggerResponse')
  }

  async setTriggerEnabled (id, enabled) {
    const response = this.getTrigger(id)
    const buffer = Buffer.alloc(17, 0x37)
    buffer.writeUInt8(triggerCommandNames.edit, 0)
    buffer.writeUInt16LE(id, 1)
    buffer.writeUInt32LE(response.buffer.readUInt32LE(3), 2) // timestamp
    buffer.writeUInt8(response.buffer.readUInt8(7), 6) // weekdays
    buffer.writeUInt8(response.buffer.readUInt8(8), 7) // position
    let flags = response.buffer.readUInt8(9)
    if (enabled) {
      flags |= 0x01
    } else {
      flags &= ~0x01
    }
    buffer.writeUInt8(flags, 8)
    await this.write('motorService', 'motorTriggerRequest', buffer)
    return (await this.getTrigger(id)).parsedValue
  }

  async getTriggers () {
    const { triggers } =
      (await this.read('motorService', 'motorCurrentState')).parsedValue
    const map = {}
    for (const id of triggers) {
      map[id] =
        (await this.getTrigger(id)).parsedValue
    }
    return map
  }

  async getVenetianMode () {
    const buffer = Buffer.alloc(1)
    buffer.writeUInt8(0xAA)
    await this.write('motorService', 'motorCalibration', buffer)
    return (await this.read(
      'motorService', 'motorCalibration'
    )).parsedValue.venetianMode
  }

  /* ===== Shade Service ==================================================== */

  async getShadeName () {
    return (await this.read('shadeService', 'shadeName')).parsedValue
  }

  async getShadeMacAddress () {
    return (await this.read('shadeService', 'shadeMacAddress')).parsedValue
  }

  async getShadeState () {
    return (await this.read('shadeService', 'shadeState')).parsedValue
  }
}

module.exports = SomaClient
