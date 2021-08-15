#!/usr/bin/env node

// homebridge-soma/cli/createBtDefinitions.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const btNumbers = require('bluetooth-numbers-database')
const fs = require('fs').promises
const he = require('he')
const homebridgeLib = require('homebridge-lib')
const path = require('path')
const xml2js = require('xml2js')

const packageJson = require('../package.json')

const { b, u } = homebridgeLib.CommandLineTool

const usage = {
  createBtDefinitions: `${b('createBtDefinitions')} [${b('-hVD')}] [${b('-t')} ${u('timeout')}]`
}

const description = {
  createBtDefinitions: `Generate the ${b('btDefinitions.json')} file.`
}

const help = {
  createBtDefinitions: `${description.createBtDefinitions}

Generate the ${b('btDefinitions.json')} containing the definitions of the
standard BLE descriptors, characteristics, services, and companies.
The information is obtained from the Bluetooth Numbers Database, by Nordic
Semiconductor, and the Bluetooth Media Library, by the Bluetooth SIG.

Usage: ${usage.createBtDefinitions}

Parameters:
  ${b('-h')}, ${b('--help')}
  Print this help and exit.

  ${b('-V')}, ${b('--version')}
  Print version and exit.

  ${b('-D')}, ${b('--debug')}
  Print debug messages.

  ${b('-t')} ${u('timeout')}, ${b('--timeout=')}${u('timeout')}
  Set timeout to ${u('timeout')} seconds instead of default ${b('5')}.`
}

function toHex (i, digits = 2) {
  return ('0000000000000000' + i.toString(16).toUpperCase()).slice(-digits)
}

// Words in uppercase to be converted to camelcase.
const _upperCaseWords = [
  'GATT'
]
const upperCaseWords = {}
for (const word of _upperCaseWords) {
  upperCaseWords[word] = {
    regexp: new RegExp('^(.*)' + word + '(.*)$'),
    lower: word.toLowerCase(),
    camel: word.charAt(0) + word.slice(1).toLowerCase()
  }
}

// Keys to be replaced.
const replacementKeys = {
  // field: 'fields'
}

// Keys that contain lists and always should return an array.
// Value is the member key, or empty string if none.
const arrayKeys = {
  characteristics: '',
  gattRequirements: 'requirement'
}

// Keys to be ignore at root.
const rootKeys = [
  'service',
  'characteristic',
  'descriptor'
]

class BtXmlParser {
  constructor () {
    this.parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
      attrNameProcessors: [this.processKey.bind(this)],
      tagNameProcessors: [this.processKey.bind(this)]
    })
  }

  async parse (xml) {
    const result = await this.parser.parseStringPromise(xml)
    return this.process(result)
  }

  // Convert key to javascript standard key.
  processKey (key) {
    for (const wordKey in upperCaseWords) {
      const word = upperCaseWords[wordKey]
      const a = word.regexp.exec(key)
      if (a != null) {
        key = a[1] + (a[1] === '' ? word.lower : word.camel) + a[2]
      }
    }
    key = key.charAt(0).toLowerCase() + key.slice(1)
    if (replacementKeys[key] != null) {
      key = replacementKeys[key]
    }
    return key
  }

  // Post-process converted XML.
  async process (value) {
    // Recursively post-process arrays.
    if (Array.isArray(value)) {
      const list = []
      for (const elt of value) {
        list.push(await this.process(elt))
      }
      return list
    }

    // Recursively post-process objects.
    if (typeof value === 'object') {
      // Ignore xmlns schemas.
      for (const key in value) {
        if (key.startsWith('xmlns') || key.startsWith('xsi:')) {
          delete value[key]
        }
      }
      // Handle single-key objects.
      const keys = Object.keys(value)
      if (keys.length === 1) {
        if (rootKeys.includes(keys[0])) {
          return this.process(value[keys[0]])
        }
      }
      // Recursively post-process key/value pairs.
      const obj = {}
      for (const key in value) {
        // Handle lists.
        if (arrayKeys[key] != null) {
          const childKey = arrayKeys[key]
          let newValue = await this.process(value[key])
          const listKeys = Object.keys(newValue)
          if (listKeys.length === 1 && listKeys[0] === childKey) {
            newValue = newValue[childKey]
          }
          if (Array.isArray(newValue)) {
            obj[key] = newValue
          } else if (
            typeof newValue === 'object' || typeof newValue === 'string'
          ) {
            obj[key] = [newValue]
          } else {
            obj[key] = []
          }
          continue
        }
        if (key === 'value') {
          let newValue = await this.process(value[key])
          const listKeys = Object.keys(newValue)
          if (listKeys.length === 1 && listKeys[0] === 'field') {
            newValue = newValue.field
            if (Array.isArray(newValue)) {
              obj.values = newValue
            } else if (
              typeof newValue === 'object' || typeof newValue === 'string'
            ) {
              obj.values = [newValue]
            } else {
              obj.values = []
            }
            continue
          }
          obj.value = newValue
        }
        obj[key] = await this.process(value[key])
      }
      return obj
    }
    return value
  }
}

function nameToKey (name) {
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

function byUuid (a, b) {
  if (a.uuid.length !== b.uuid.length) {
    return a.uuid.length - b.uuid.length
  }
  if (a.uuid === b.uuid) {
    return 0
  }
  return a.uuid > b.uuid ? 1 : -1
}

class Main extends homebridgeLib.CommandLineTool {
  constructor () {
    super()
    this.usage = usage.createBtDefinitions
  }

  async main () {
    try {
      this._clargs = this.parseArguments()
      this.createBtMediaLibrary()

      this.descriptors = {}
      this.descriptorsByKey = {}
      this.descriptorDefinitions = 0
      this.debug('Bluetooth Numbers: %d descriptors', btNumbers.descriptors.length)
      for (const descriptor of btNumbers.descriptors.sort(byUuid)) {
        descriptor.key = nameToKey(descriptor.name)
        const definition = await this.readIdentifier(descriptor.identifier)
        if (definition != null) {
          this.descriptorDefinitions++
          descriptor.definition = definition
        }
        this.descriptors[descriptor.uuid] = descriptor
        this.descriptorsByKey[descriptor.key] = descriptor.uuid
      }

      this.characteristics = {}
      this.characteristicsByKey = {}
      this.characteristicDefinitions = 0
      this.debug('Bluetooth Numbers: %d characteristics', btNumbers.characteristics.length)
      for (const characteristic of btNumbers.characteristics.sort(byUuid)) {
        characteristic.key = nameToKey(characteristic.name)
        const definition = await this.readIdentifier(characteristic.identifier)
        if (definition != null) {
          this.characteristicDefinitions++
          characteristic.definition = definition
        }
        this.characteristics[characteristic.uuid] = characteristic
        this.characteristicsByKey[characteristic.key] = characteristic.uuid
      }

      this.services = {}
      this.servicesByKey = {}
      this.serviceDefinitions = 0
      this.debug('Bluetooth Numbers: %d services', btNumbers.services.length)
      for (const service of btNumbers.services.sort(byUuid)) {
        service.key = nameToKey(service.name)
        const definition = await this.readIdentifier(service.identifier)
        if (definition != null) {
          this.serviceDefinitions++
          service.definition = definition
        }
        this.services[service.uuid] = service
        this.servicesByKey[service.key] = service.uuid
      }

      this.companies = {}
      this.debug('Bluetooth Numbers: %d companies', btNumbers.companies.length)
      for (const company of btNumbers.companies) {
        this.companies[toHex(company.code, 4)] = he.decode(company.name)
      }

      this.createFile()
    } catch (error) { this.error(error) }
  }

  parseArguments () {
    const parser = new homebridgeLib.CommandLineParser(packageJson)
    const clargs = {
      options: {
        timeout: 5
      }
    }
    parser
      .help('h', 'help', help.createBtDefinitions)
      .version('V', 'version')
      .flag('D', 'debug', () => {
        if (this.vdebugEnabled) {
          this.setOptions({ vvdebug: true })
        } else if (this.debugEnabled) {
          this.setOptions({ vdebug: true })
        } else {
          this.setOptions({ debug: true, chalk: true })
        }
      })
      .option('t', 'timeout', (value) => {
        clargs.options.timeout = homebridgeLib.OptionParser.toInt(
          'timeout', value, 1, 60, true
        )
      })
      .parse()
    return clargs
  }

  createBtMediaLibrary () {
    const parser = new BtXmlParser()
    this.btMediaLibrary = new homebridgeLib.HttpClient({
      https: true,
      host: 'www.bluetooth.com',
      maxSockets: 1,
      name: 'Bluetooth Library',
      path: '/wp-content/uploads/Sitecore-Media-Library/Gatt/Xml/',
      timeout: 15,
      xmlParser: parser.parse.bind(parser)
    })
    this.btMediaLibrary
      .on('error', (error) => {
        if (error.request == null) {
          this.warn('%s: %s', this.btMediaLibrary.name, error)
          return
        }
        this.log(
          '%s: request %d: %s %s', this.btMediaLibrary.name, error.request.id,
          error.request.method, error.request.resource
        )
        this.warn(
          '%s: request %d: %s', this.btMediaLibrary.name, error.request.id,
          error
        )
      })
      .on('request', (request) => {
        this.debug(
          '%s: request %d: %s %s', this.btMediaLibrary.name, request.id,
          request.method, request.resource
        )
      })
      .on('response', (response) => {
        this.debug(
          '%s: request %d: %d %s', this.btMediaLibrary.name, response.request.id,
          response.statusCode, response.statusMessage
        )
        if (response.parsedBody != null) {
          this.vvdebug(
            '%s: request %d: response: %j', this.btMediaLibrary.name,
            response.request.id, response.body
          )
          this.vdebug(
            '%s: request %d: response: %j', this.btMediaLibrary.name,
            response.request.id, response.parsedBody
          )
        }
      })
  }

  async readIdentifier (identifier) {
    if (!identifier.startsWith('org.bluetooth.')) {
      return null
    }
    const a = identifier.split('.')
    const dir = a[2][0].toUpperCase() + a[2].slice(1) + 's/'
    try {
      const response = await this.btMediaLibrary.get(dir + identifier + '.xml')
      if (response.parsedBody != null) {
        return response.parsedBody
      }
    } catch (error) {}
    return null
  }

  async createFile () {
    const output = {
      description: 'This file is generated.  Do not edit.',
      generated: {
        program: packageJson.homepage.split('#')[0] +
          '/cli/' + path.basename(__filename),
        version: packageJson.version,
        date: new Date().toISOString().slice(0, -8) + 'Z',
        sources: {
          numbers: 'bluetooth-numbers-database@' + btNumbers.version,
          definitions: this.btMediaLibrary.__params.url
        }
      },
      services: this.services,
      servicesByKey: this.servicesByKey,
      characteristics: this.characteristics,
      characteristicsByKey: this.characteristicsByKey,
      descriptors: this.descriptors,
      descriptorsByKey: this.descriptorsByKey,
      companies: this.companies
    }
    const jsonFormatter = new homebridgeLib.JsonFormatter()
    const text = jsonFormatter.stringify(output)
    const filename = path.join(__dirname, '..', 'lib', 'btDefinitions.json')
    this.log(
      '%s: %d/%d descriptors, %d/%d characteristics, %d/%d servicesm, %d companies',
      filename,
      this.descriptorDefinitions, btNumbers.descriptors.length,
      this.characteristicDefinitions, btNumbers.characteristics.length,
      this.serviceDefinitions, btNumbers.services.length,
      btNumbers.companies.length
    )
    await fs.writeFile(filename, text)
  }
}

new Main().main()
