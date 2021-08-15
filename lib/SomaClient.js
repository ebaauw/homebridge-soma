// homebridge-soma/lib/SomaClient.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const BleClient = require('./BleClient')
const {
  toHex, bufferToHex //, bufferToManufacturer, nameToKey, uuidToString
} = require('./BleUtils.js')

const triggerCommands = {
  0x13: 'add',
  0x23: 'remove',
  0x33: 'read',
  0x43: 'edit',
  0x63: 'clearAll'
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
        f: b => toHex(b.readUInt8())
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
    currentPosition: buffer.readUInt8(4) * 2 - 100,
    targetPosition: buffer.readUInt8(5) * 2 - 100,
    displayName: parseCString(buffer.slice(6))
  }
}

class SomaClient extends BleClient {
  static get SomaPeripheral () { return SomaPeripheral }

  constructor () {
    super({
      allowDuplicates: true,
      scanDuration: 0
    })
    this.on('deviceFound', (device) => {
      if (device.manufacturer.code === '0370') {
        Object.assign(device, parseManufacturerData(
          device.peripheral.advertisement.manufacturerData
        ))
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
}

module.exports = SomaClient
