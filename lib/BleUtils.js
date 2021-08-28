// homebridge-soma/lib/BleUtils.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const definitions = require('./btDefinitions.json')

/** Map integer value to hex string.
  * @param {integer} value - The integer value.
  * @param {integer} [digits=2] - The number of digits in the hex string.
  * @param {boolean} [prefix=true] - Prefix hex string with `"0x"`.
  * @return {string} - The human readable hex string.
  */
function toHex (value, digits = 2, prefix = true) {
  return (prefix ? '0x' : '') +
    ('00000000000000000000000000000000' + value.toString(16))
      .toUpperCase().slice(-digits)
}

/** Map buffer to human readable hex string.
  * @param {Buffer} buffer - The buffer.
  * @return {string} - The human readable hex string.
  */
function bufferToHex (buffer) {
  if (buffer == null || !Buffer.isBuffer(buffer)) {
    return null
  }
  return '0x' + buffer.toJSON().data.map((value) => {
    return toHex(value, 2, false)
  }).join(' ')
}

/** Extract manufacturer code and name from manufacturer data buffer.
  * @param {Buffer} buffer - The manufacturer data buffer from the advertisement.
  * @return {Object} - The manufacturer `code` and `name`.
  */
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

/** Map human reable service or characteristic name to JavaScript key.
  * @param {string} name - The human readable name.
  * @return {string} - The JavaScript key.
  */
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

/** Map human reable UUID to UUID as used by Noble.
  * @param {string} s - The UUID as human readable string.
  * @return {string} - The UUID as used by Noble,
  */
function stringToUuid (s) {
  if (s == null || typeof s !== 'string') {
    return null
  }
  return s.replace(/-/g, '').toLowerCase()
}

/** Map UUID as used by Noble to human readable string.
  * @param {string} uuid - The UUID as used by Noble.
  * @return {string} - The UUID as human readable string.
  */
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
  stringToUuid,
  uuidToString
}
