// homebridge-soma/lib/BleUtils.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const definitions = require('./btDefinitions.json')

function toHex (value, digits = 2, prefix = true) {
  return (prefix ? '0x' : '') +
    ('00000000000000000000000000000000' + value.toString(16))
      .toUpperCase().slice(-digits)
}

function bufferToHex (buffer) {
  if (buffer == null || !Buffer.isBuffer(buffer)) {
    return null
  }
  return '0x' + buffer.toJSON().data.map((value) => {
    return toHex(value, 2, false)
  }).join(' ')
}

function bufferToManufacturer (buffer) {
  if (buffer == null || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null
  }
  const id = toHex(buffer.readUInt16LE(0), 4, false)
  return {
    code: id,
    name: definitions.companies[id] == null
      ? '0x' + id
      : definitions.companies[id]
  }
}

function nameToKey (name) {
  if (name == null || typeof name !== 'string') {
    return null
  }
  const key = name.replace(/-/g, ' ')
  const a = key.split(' ')
  for (const i in a) {
    if (i === '0') {
      a[i] = a[i].toLowerCase()
    } else {
      a[i] = a[i].charAt(0).toUpperCase() + a[i].slice(1).toLowerCase()
    }
  }
  return a.join('')
}

function uuidToString (uuid) {
  if (uuid == null || typeof uuid !== 'string') {
    return null
  }
  if (uuid.length === 32) {
    uuid = [
      uuid.slice(0, 8),
      uuid.slice(8, 12),
      uuid.slice(12, 16),
      uuid.slice(16, 20),
      uuid.slice(20, 32)
    ].join('-')
  }
  return uuid.toUpperCase()
}

module.exports = {
  toHex,
  bufferToHex,
  bufferToManufacturer,
  nameToKey,
  uuidToString
}
