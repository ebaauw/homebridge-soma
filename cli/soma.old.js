#!/usr/bin/env node

// homebridge-soma/cli/soma.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const noble = require('@abandonware/noble')

const shadeUuidRegExp = /0000([0-9A-F]{4})B87F490C92CB11BA5EA5167C/

// In order reported by the shade.
const uuidDefinitions = {
  1800: { name: 'Generic Access' }, // Not discovered on macOS.
  '2A00': { name: 'Device Name', f: parseString }, // read
  '2A01': { name: 'Appearance', f: parseUInt16 }, // read
  '2A04': { name: 'Peripheral Preferred Connection Parameters', f: parse2A04 }, // read

  1801: { name: 'Generic Attribute' }, // Not discovered on macOS.
  '2A05': { name: 'Service Changed' }, // indicate

  '180A': { name: 'Device Information' },
  '2A29': { name: 'Manufacturer Name', f: parseString }, // read
  '2A25': { name: 'Serial Number', f: parseString }, // read
  '2A27': { name: 'Hardware Revision', f: parseString }, // read
  '2A26': { name: 'Firmware Revision', f: parseString }, // read
  '2A28': { name: 'Software Revision', f: parseString }, // read

  '180F': { name: 'Battery Service' },
  '2A19': { name: 'Battery Level', f: parseUInt8 }, // read
  // Time Service (custom)
  1554: { name: 'Time Service', custom: true },
  1555: { name: 'Current Time', custom: true, f: parseDate }, // read, write, notify
  // Motor Service (custom)
  1861: { name: 'Motor Service', custom: true },
  1525: { name: 'Motor Current State', custom: true, f: parse1525 }, // read, notify
  1526: { name: 'Motor Target State', custom: true, f: parseUInt8 }, // read, write
  1527: { name: 'Motor Trigger Request', custom: true, f: parse1527 }, // read, write
  1528: { name: 'Motor Trigger Response', custom: true, f: parse1528 }, // read, notify
  1529: { name: 'Motor Calibration', custom: true, f: parseUInt8Hex }, // read, write, notify
  1530: { name: 'Motor Control', custom: true, f: parseUInt8Hex }, // read, write
  1531: { name: 'Motor Notify', custom: true, f: parseBoolean }, // read, write
  1532: { name: 'Motor Solar Panel Voltage', custom: true, f: parseUInt16 }, // read
  1533: { name: 'Motor Touch Button Enabled', custom: true, f: parseBoolean }, // read, write
  1534: { name: 'Motor Speed', custom: true, f: parseUInt8 }, // read, write
  BA71: { name: 'Motor Battery Level', custom: true, f: parseUInt16 }, // read, notify
  BA72: { name: 'Motor Under Voltage', custom: true, f: parseBoolean }, // read, notify - Under Voltage?
  // Shade Service (Custome)
  1890: { name: 'Shade Service', custom: true },
  1891: { name: 'Shade Firmware Control', custom: true, f: parseUInt8Hex }, // read, write, indicate
  1892: { name: 'Shade Name', custom: true, f: parseCString }, // read, write
  1893: { name: 'Group Name', custom: true, f: parseCString }, // read, write
  1894: { name: 'Shade State', custom: true, f: parseShadeState }, // read, notify
  1895: { name: 'Shade Mac Address', custom: true, f: parseString }, // read
  1896: { name: 'Shade Config', custom: true, f: parseShadeConfig } // read, write, notify
}

function toShortUuid (uuid) {
  uuid = uuid.toUpperCase()
  const a = shadeUuidRegExp.exec(uuid)
  if (a != null) {
    return a[1]
  }
  return uuid
}

function toHex (value, digits = 2) {
  return '0x' + ('0000000000000000' + value.toString(16).toUpperCase()).slice(-digits)
}

function parseString (buffer) {
  return buffer.toString().trim()
}

function parseBoolean (buffer) {
  return buffer.readUInt8() !== 0
}

function parseUInt8 (buffer) {
  return buffer.readUInt8()
}

function parseUInt8Hex (buffer) {
  return toHex(buffer.readUInt8())
}

function parseUInt16 (buffer) {
  return buffer.readUInt16LE()
}

function parseDate (buffer) {
  return (new Date(buffer.readUInt32LE() * 1000)).toISOString().slice(0, -5)
}

function parseBuffer (buffer) {
  if (buffer.length === 1) {
    return buffer.readUInt8()
  }
  return buffer.toJSON().data
}

function parseBufferHex (buffer) {
  if (buffer.length === 1) {
    return toHex(buffer.readUInt8())
  }
  return parseBuffer(buffer).map((value) => { return toHex(value) })
}

function parseCString (buffer) {
  const s = buffer.toString()
  return s.slice(0, s.indexOf('\0')).trim() // .slice(0, -1)
}

function parse2A04 (buffer) {
  return {
    minimumConnectionInterval: buffer.readUInt16LE(0),
    maximumConnectionInterval: buffer.readUInt16LE(2),
    slaveLatency: buffer.readUInt16LE(4),
    connectionSupervisionTimeoutMultiplier: buffer.readUInt16LE(6)
  }
}

function parse1525 (buffer) {
  const triggers = []
  for (let i = 0; i < 16; i++) {
    const id = buffer.readUint16LE(2 * i + 1)
    if (id !== 0) {
      triggers.push(id)
    }
  }
  return {
    position: buffer.readUInt8(0),
    triggers: triggers
  }
}

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

function parse1527 (buffer) {
  const commandCode = buffer.readUInt8(0)
  const command = triggerCommands[commandCode] == null
    ? toHex(commandCode)
    : triggerCommands[commandCode]
  const result = {
    command: command,
    id: buffer.readUInt16LE(1)
  }
  if (command === 'add' || command === 'edit') {
    Object.assign(result, parseTrigger(buffer.slice(3)))
  }
  return result
}

function parse1528 (buffer) {
  const statusCode = buffer.readUInt8(0)
  const status = triggerStatus[statusCode] == null
    ? toHex(statusCode)
    : triggerStatus[statusCode]
  const commandCode = buffer.readUInt8(1)
  const command = triggerCommands[commandCode] == null
    ? toHex(commandCode)
    : triggerCommands[commandCode]
  const result = {
    status: status,
    command: command
  }
  if (status === 'success' && command === 'read') {
    result.id = buffer.readUInt16LE(2)
    Object.assign(result, parseTrigger(buffer.slice(4)))
  }
  return result
}

function parseShadeState (buffer) {
  return {
    chargingLevel: buffer.readUInt16LE(0), // This is also the light level.
    panelLevel: buffer.readUInt16LE(2)
  }
}

function parseShadeConfig (buffer) {
  return {
    restartReason: toHex(buffer.readUInt8(8)),
    bootSeq: buffer.readUInt8(9),
    motorSpeed: buffer.readUInt8(13),
    rawValue: parseBufferHex(buffer)
  }
}

const uuids = {} // Map key to UUID.

for (const uuid in uuidDefinitions) {
  const definition = uuidDefinitions[uuid]
  let key = definition.name.replace(/ /g, '')
  key = key.charAt(0).toLowerCase() + key.slice(1)
  definition.key = key
  if (definition.f == null) {
    definition.f = parseBufferHex
  }
  uuids[key] = definition.custom ? `0000${uuid}B87F490C92CB11BA5EA5167C` : uuid
}

const jsonFormatter = new homebridgeLib.JsonFormatter({
  maxDepth: 2
  // sortKeys: true
})

async function guard (promise, timeout = 5) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      timer = null
      reject(new Error(`no response in ${timeout}s`))
    }, timeout * 1000)
    promise.then((result) => {
      if (timer != null) {
        clearTimeout(timer)
        resolve(result)
      }
    })
  })
}

async function initShade (shade) {
  delete shade.notYetInitialised
  for (const service of shade.peripheral.services) {
    const serviceUuid = toShortUuid(service.uuid)
    const def = uuidDefinitions[serviceUuid] || {}
    const serviceName = service.name != null
      ? service.name
      : def.name != null ? def.name : 'Unknown'
    console.log(
      '%s: %s [%s]: %d characteristics', shade.id, serviceUuid,
      serviceName, service.characteristics.length
    )
    for (const characteristic of service.characteristics) {
      const characteristicUuid = toShortUuid(characteristic.uuid)
      const def = uuidDefinitions[characteristicUuid] || {}
      const characteristicName = characteristic.name != null
        ? characteristic.name
        : def.name != null ? def.name : 'Unknown'
      const key = def.key != null ? def.key : characteristicUuid
      console.log(
        '%s:   %s [%s]: %j', shade.id, characteristicUuid,
        characteristicName, key, characteristic.properties
      )
      if (characteristic.properties.includes('notify')) {
        characteristic.on('data', (value, isNotification) => {
          if (isNotification) {
            console.log(
              '%s: %s: %j (%s)', shade.id, key, def.f(value)
            )
          }
        })
        try {
          console.log('%s: %s: subscribing...', shade.id, key)
          await guard(characteristic.notifyAsync(true))
        } catch (error) { console.error(error) }
      }
    }
  }
}

async function pollShade (shade) {
  console.log('%s: connecting...', shade.id)
  await guard(shade.peripheral.connectAsync())
  console.log('%s: discovering services and characteristics...', shade.id)
  await guard(shade.peripheral.discoverAllServicesAndCharacteristicsAsync(), 20)
  shade.address = shade.peripheral.address.replace(/-/g, ':').toUpperCase()
  if (shade.notYetInitialised) {
    await initShade(shade)
  }
  const result = {}
  for (const service of shade.peripheral.services) {
    for (const characteristic of service.characteristics) {
      const characteristicUuid = toShortUuid(characteristic.uuid)
      const def = uuidDefinitions[characteristicUuid] || {}
      const key = def.key != null ? def.key : '0x' + characteristicUuid
      if (characteristic.properties.includes('read')) {
        try {
          console.log('%s: %s [%s]: reading...', shade.id, characteristicUuid, key)
          const value = await guard(characteristic.readAsync())
          console.log('%s: %s [%s]: %j', shade.id, characteristicUuid, key, parseBufferHex(value))
          const parsedValue = def.f(value)
          console.log('%s: %s [%s]: %j', shade.id, characteristicUuid, key, parsedValue)
          result[key] = parsedValue
        } catch (error) { console.error(error) }
      }
    }
  }
  console.log(jsonFormatter.stringify(result))
  console.log('%s: disconnecting...', shade.id)
  await guard(shade.peripheral.disconnectAsync())
}

let state
const shades = {}

noble
  .on('error', (error) => { console.error('error: %s', error) })
  .on('warning', (message) => { console.log('warning: %s', message) })
  .on('stateChange', async (newState) => {
    const oldState = state
    state = newState
    console.log('state: %s', state)
    if (state === 'poweredOn') {
      try {
        console.log('start scanning...')
        await guard(noble.startScanningAsync())
      } catch (error) { console.error(error) }
    } else if (oldState === 'poweredOn') {
      try {
        console.log('stop scanning...')
        await guard(noble.stopScanningAsync())
      } catch (error) { console.error(error) }
    }
  })
  .on('scanStart', async () => {
    console.log('scanning started')
    await homebridgeLib.timeout(15000)
    if (state === 'poweredOn') {
      console.log('stop scanning...')
      try {
        await guard(noble.stopScanningAsync())
      } catch (error) { console.error(error) }
    }
  })
  .on('scanStop', async () => {
    console.log('scanning stopped - found %d shades', Object.keys(shades).length)
    for (const id in shades) {
      try {
        await pollShade(shades[id])
      } catch (error) { console.error(error) }
    }
    await homebridgeLib.timeout(15000)
    if (state === 'poweredOn') {
      console.log('start scanning...')
      try {
        await guard(noble.startScanningAsync())
      } catch (error) { console.error(error) }
    }
  })
  .on('discover', async (peripheral) => {
    const name = peripheral.advertisement.localName
    const address = peripheral.address.replace(/-/g, ':').toUpperCase()

    if (name === 'S') {
    // if (address === 'F8:7E:82:17:02:D6') { // Office
    // if (address === 'FD:D0:FF:78:DA:76') { // Living Room 1
    // if (address === 'FD:A7:89:A6:8D:F7') { // Living Room 2
    // if (address === 'C8:01:2C:5E:EE:E7') { // Living Room 3
      const id = peripheral.id
      if (shades[id] == null) {
        peripheral
          .on('connect', () => { console.log('%s: connected', peripheral.id) })
          .on('disconnect', () => { console.log('%s: disconnected', peripheral.id) })
        shades[id] = {
          id: id,
          name: name,
          address: address,
          notYetInitialised: true,
          peripheral: peripheral
        }
      }
      const buffer = peripheral.advertisement.manufacturerData
      const data = {
        manufacturerCode: toHex(buffer.readUInt16LE(), 4),
        advDataProtocol: toHex(buffer.readUInt8(2)),
        battery: buffer.readUInt8(3) & 0x7F,
        currentPosition: buffer.readUInt8(4),
        targetPosition: buffer.readUInt8(5),
        displayName: parseCString(buffer.slice(6))
      }
      const manufacturer = toHex(buffer.readUInt16LE(), 4)
      const displayName = parseCString(buffer.slice(6))
      console.log(
        '%s: %s by %s [%s] at %s %s', id, name,
        manufacturer, displayName, address, jsonFormatter.stringify(data)
      )
    }
  })
