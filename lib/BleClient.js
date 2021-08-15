// homebridge-soma/lib/BleClient.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const events = require('events')
const fs = require('fs').promises
const noble = require('@abandonware/noble')
const os = require('os')

const {
  toHex, bufferToHex, bufferToManufacturer, nameToKey, uuidToString
} = require('./BleUtils.js')

/** Bluetooth Low Energy error.
  * @hideconstructor
  * @extends Error
  * @memberof BleClient
  */
class BleError extends Error {
  constructor (message, request) {
    super(message)
    /** @member {BleRequest} - The request that caused the error.
      * See {@link BleClient.BleRequest BleRequest}.
      */
    this.request = request
  }
}

/** Bluetooth Low Energy request.
  * @hideconstructor
  * @memberof BleClient
  */
class BleRequest {
  constructor (request, peripheralDelegate, serviceDelegate, characteristicDelegate) {
    /** @member {string} - The request.
      */
    this.request = request
    /** @member {?BlePeripheralDelegate} - The delegate for the peripheral.
      */
    this.peripheralDelegate = peripheralDelegate
    /** @member {?BleServiceDelegate} - The delegate for the service.
      */
    this.serviceDelegate = serviceDelegate
    /** @member {?BleCharacteristicDelegate} - The delegate for the characteristic.
      */
    this.characteristicDelegate = characteristicDelegate
  }
}

/** Bluetooth Low Energy response.
  * @hideconstructor
  * @memberof BleClient
  */
class BleResponse {
  constructor (request, buffer) {
    /** @member {BleRequest} - The request that generated the response.
      * See {@link BleClient.BleRequest BleRequest}.
      */
    this.request = request
    /** @member {?Buffer} - The response to the request.
      */
    this.buffer = buffer
  }
}

/** Bluetooth Low Energy notification.
  * @hideconstructor
  * @memberof BleClient
  */
class BleNotification {
  constructor (serviceDelegate, characteristicDelegate, buffer, value) {
    /** @member {BleServiceDelegate} - The delegate for the service.
      */
    this.serviceDelegate = serviceDelegate
    /** @member {BleCharacteristicDelegate} - The delegate for the characteristic.
      */
    this.characteristicDelegate = characteristicDelegate
    /** @member {Buffer} - The raw value.
      */
    this.buffer = buffer
    /** @member {*} - The parsed value.
      */
    this.value = value
  }
}

class BleClient extends events.EventEmitter {
  static get BleError () { return BleError }
  static get BleRequest () { return BleRequest }
  static get BleResponse () { return BleResponse }
  static get BleNotification () { return BleNotification }
  static get BlePeripheralDelegate () { return BlePeripheralDelegate }
  static get BleServiceDelegate () { return BleServiceDelegate }
  static get BleCharacteristicDelegate () { return BleCharacteristicDelegate }

  /**
    * @param {?object} params - Parameters
    * @param {boolean} [params.allowDuplicates = false] - Allow duplicates while scanning.
    * @param {integer} [params.timeout = 15] - Request timeout (in seconds).
    * @param {integer} [params.scanTimeout = 120] - Scanning duration (in seconds).
    * Set to 0 for continuous scanning.
    */
  constructor (params = {}) {
    super()

    // FIXME parameter checking
    this.allowDuplicates = params.allowDuplicates || false
    this.timeout = params.timeout != null ? params.timeout : 15
    this.scanDuration = params.scanDuration != null ? params.scanDuration : 30

    this.requestId = 0

    noble
      .on('warning', (message) => { this.emit('error', new BleError(message)) })
      .on('stateChange', async (newState) => {
        await this.checkPlatform()
        const oldState = this._state
        this._state = newState
        if (this.enabled) {
          /** Emitted when bluetooth is enabled.
            * @event BleClient#enabled
            */
          this.emit('enabled', this.platform, this.arch)
          try {
            await this.search()
          } catch (error) { this.emit('error', error) }
        } else {
          /** Emitted when bluetooth is disabled.
            * @event BleClient#disabled
            */
          this.emit('disabled')
          if (oldState === 'poweredOn') {
            try {
              await this.stopSearch()
            } catch (error) { this.emit('error', error) }
          }
        }
      })
      .on('scanStart', () => {
        /** Emitted when searching for Bluetooth peripherals.
          * @event BleClient#searching
          */
        this.emit('searching')
        if (this.scanDuration !== 0) {
          this.scanTimer = setTimeout(async () => {
            try {
              this.scanTimer = null
              await this.stopSearch()
            } catch (error) { this.emit(error) }
          }, this.scanDuration * 1000)
        }
      })
      .on('scanStop', async () => {
        try {
          if (this.scanTimer != null) {
            clearTimeout(this.scanTimer)
            delete this.connectionTimer
          }
          /** Emitted when no longer searching for Bluetooth peripherals.
            * @event BleClient#stopSearching
            */
          this.emit('stopSearching')
          if (this.scanDuration === 0) {
            await this.search()
          }
        } catch (error) { this.emit('error', error) }
      })
      .on('discover', (peripheral) => {
        if (peripheral.connectable) {
          /** Emitted when a Bluetooth peripheral has been found.
            * @event BleClient#stopSearching
            * @param {Peripheral} peripheral
            */
          this.emit('deviceFound', {
            address: peripheral.address !== ''
              ? peripheral.address.replace(/-/g, ':').toUpperCase()
              : null,
            id: peripheral.id,
            manufacturer: bufferToManufacturer(
              peripheral.advertisement.manufacturerData
            ),
            name: peripheral.advertisement.localName,
            peripheral: peripheral
          })
        }
      })
  }

  async checkPlatform () {
    if (this.platform == null) {
      this.platform = os.platform()
      this.arch = os.arch()
      if (this.platform === 'darwin' && this.arch === 'x64') {
        this.platform = 'macOS'
        this.macOs = true
        return
      }
      if (this.platform === 'linux' && ['arm', 'arm64'].includes(this.arch)) {
        const stat = await fs.stat('/usr/bin/vcgencmd')
        if (stat.isFile()) {
          this.platform = 'Raspberry Pi OS'
          this.piOs = true
          return
        }
      }
      this.emit('error', new BleError(
        `unsupported platform: ${this.platform} on ${this.arch}`
      ))
    }
  }

  /** Bluetooth is enabled.
    * @type {boolean}
    */
  get enabled () { return this._state === 'poweredOn' }

  /** Start scanning for peripherals.
    * @param {integer} [timeout = 120] - Scanning duration (in seconds).
    * Set to 0 for continuous scanning.
    */
  async search (duration = this.scanDuration, allowDuplicates = this.allowDuplicates) {
    if (this.scanTimer != null) {
      clearTimeout(this.scanTimer)
      delete this.scanTimer
    }
    this.scanDuration = duration
    return this.request(
      new BleRequest('startScanning'),
      noble.startScanningAsync([], allowDuplicates)
    )
  }

  /** Stop scanning for peripherals.
    */
  async stopSearch () {
    return this.request(
      new BleRequest('stopScanning'),
      noble.stopScanningAsync()
    )
  }

  /** Execute a Bluetooth Low Energy request.
    *
    * The request is guarded against disabling bluetooth, the peripheral
    * disconnecting unexpectedly, or a timeout.
    *
    * @param {BleRequest} request - The request info.
    * @param {Promise} promise - The promise executing the request.
    * @param {integer} [timeout = 15] - Request timeout (in seconds).
    * @emits request
    * @emits response
    * @return {BleResponse} - The response.
    * @throws {BleError} -
    */
  async request (request, promise, timeout = this.timeout) {
    return new Promise((resolve, reject) => {
      const peripheralDelegate = request.peripheralDelegate
      const peripheral = peripheralDelegate != null
        ? peripheralDelegate.peripheral
        : null

      // Setup timer to guard for timeouts.
      const timer = setTimeout(() => {
        this.removeListener('disabled', onDisabled)
        if (peripheralDelegate != null) {
          peripheralDelegate.removeListener('disconnect', onDisconnect)
        }
        reject(new BleError(`no response in ${timeout}s`, request))
        if (peripheralDelegate != null && peripheral.state === 'connecting') {
          if (!this.macOs) {
            peripheral.cancelConnect()
          }
        }
      }, timeout * 1000)

      // Setup guard for Bluetooth disabled.
      function onDisabled () {
        clearTimeout(timer)
        if (peripheralDelegate != null) {
          peripheralDelegate.removeListener('disconnect', onDisconnect)
        }
        reject(new BleError(new BleError('bluetooth disabled'), request))
      }
      this.once('disabled', onDisabled)

      // Setup guard for peripheral disconnect.
      function onDisconnect () {
        clearTimeout(timer)
        this.removeListener('disabled', onDisabled)
        reject(new BleError('disconnected unexpectedly'), request)
      }
      if (peripheralDelegate == null) {
        /** Emitted when a request has been sent.
          * @event BleClient#request
          * @param {BleClient.BleRequest} request - The request.
          */
        request.id = ++this.requestId
        this.emit('request', request)
      } else {
        peripheralDelegate.once('disconnect', onDisconnect)
      }

      // Issue the request.
      promise
        .then((buffer) => {
          const response = new BleResponse(request, buffer)
          if (peripheralDelegate == null) {
            /** Emitted when a valid response has been received.
              * @event BleClient#response
              * @param {BleClient.BleResponse} response - The response.
              */
            this.emit('response', response)
          }
          resolve(response)
        })
        .catch((error) => {
          if (peripheralDelegate == null) {
            this.emit('error', error)
          }
          reject(error)
        })
        .finally(() => {
          clearTimeout(timer)
          this.removeListener('disabled', onDisabled)
          if (peripheralDelegate != null) {
            peripheralDelegate.removeListener('disconnect', onDisconnect)
          }
        })
    })
  }
}

const globalUuidDefinitions = {
  1800: {
    name: 'Generic Access', // Not discovered on macOS.
    characteristics: {
      '2A00': { name: 'Device Name', f: b => b.toString().trim() }, // read
      '2A01': { name: 'Appearance', f: b => toHex(b.readUInt16LE(), 4) }, // read
      '2A04': {
        name: 'Peripheral Preferred Connection Parameters',
        f: b => {
          return {
            minimumConnectionInterval: b.readUInt16LE(),
            maximumConnectionInterval: b.readUInt16LE(),
            slaveLatency: b.readUInt16LE(),
            connectionSupervisionTimeoutMultiplier: toHex(b.readUInt16LE(), 4)
          }
        }
      } // read
    }
  },
  1801: {
    name: 'Generic Attribute', // Not discovered on macOS.
    characteristics: {
      '2A05': {
        name: 'Service Changed',
        f: b => {
          return {
            startOfAffectedAttributeHandleRange: b.readUInt16LE(),
            endOfAffectedAttributeHandleRange: b.readUInt16LE()
          }
        }
      } // indicate
    }
  },
  '180A': {
    name: 'Device Information',
    characteristics: {
      '2A29': { name: 'Manufacturer Name', f: b => b.toString().trim() }, // read
      '2A24': { name: 'Model Number', f: b => b.toString().trim() }, // read
      '2A25': { name: 'Serial Number', f: b => b.toString().trim() }, // read
      '2A27': { name: 'Hardware Revision', f: b => b.toString().trim() }, // read
      '2A26': { name: 'Firmware Revision', f: b => b.toString().trim() }, // read
      '2A28': { name: 'Software Revision', f: b => b.toString().trim() } // read
    }
  },
  '180F': {
    name: 'Battery Service',
    characteristics: {
      '2A19': { name: 'Battery Level', f: b => b.readUInt8() } // read
    }
  }
}

class BlePeripheralDelegate extends events.EventEmitter {
  constructor (client, peripheral, uuidDefinitions = {}) {
    super()
    this.requestId = 0
    this.client = client
    this.peripheral = peripheral
    this.id = this.peripheral.id
    this.address = this.peripheral.address !== ''
      ? this.peripheral.address.replace(/-/g, ':').toUpperCase()
      : null
    this.serviceDelegates = {}
    this.peripheral
      .on('connect', () => {
        if (this.address == null) {
          this.address = this.peripheral.address !== ''
            ? peripheral.address.replace(/-/g, ':').toUpperCase()
            : null
        }
        /** Emitted when peripheral has connected.
          * @event BleClient#connected
          */
        this.emit('connected')
        if (this.connectionDuration !== 0) {
          this.connectionTimer = setTimeout(async () => {
            try {
              this.connectionTimer = null
              await this.disconnect(this.connectionTimer)
            } catch (error) { this.emit(error) }
          }, this.connectionDuration * 1000)
        }
      })
      .on('disconnect', async () => {
        try {
          if (this.connectionTimer != null) {
            clearTimeout(this.connectionTimer)
            delete this.connectionTimer
          }
          /** Emitted when peripheral has disconnected.
            * @event BleClient#disconnected
            */
          this.emit('disconnected')
          for (const key in this.serviceDelegates) {
            this.serviceDelegates[key].service = null
          }
          if (this.connectionDuration === 0) {
            await this.connect()
          }
        } catch (error) { this.emit('error', error) }
      })
    this.connectionDuration = 120 // FIXME
    this.serviceDelegates = {}
    this.definitions = Object.assign({}, globalUuidDefinitions, uuidDefinitions)
    for (const uuid in this.definitions) {
      const serviceDefinition = this.definitions[uuid]
      serviceDefinition.key = nameToKey(serviceDefinition.name)
      for (const uuid in serviceDefinition.characteristics) {
        const definition = serviceDefinition.characteristics[uuid]
        definition.key = nameToKey(definition.name)
      }
    }
  }

  createServiceDelegate (service) {
    const uuid = uuidToString(service.uuid)
    if (this.definitions[uuid] == null) {
      this.definitions[uuid] = {
        characteristics: {},
        key: uuid
      }
    }
    const definition = this.definitions[uuid]
    if (this.serviceDelegates[definition.key] == null) {
      this.serviceDelegates[definition.key] = new BleServiceDelegate(
        this, service
      )
    } else {
      this.serviceDelegates[definition.key].service = service
    }
    return this.serviceDelegates[definition.key]
  }

  async connect (duration = this.connectionDuration) {
    if (this.connectionTimer != null) {
      clearTimeout(this.connectionTimer)
      delete this.connectionTimer
    }
    this.connectionDuration = duration
    if (this.peripheral.state === 'connected') {
      if (this.connectionDuration !== 0) {
        this.connectionTimer = setTimeout(async () => {
          try {
            this.connectionTimer = null
            await this.peripheral.disconnectAsync()
          } catch (error) { this.emit(error) }
        })
      }
      return
    }
    return this.request(
      new BleRequest('connect'),
      this.peripheral.connectAsync()
    )
  }

  async disconnect (duration) {
    return this.request(
      new BleRequest('disconnect', duration),
      this.peripheral.disconnectAsync()
    )
  }

  async readAll () {
    await this.connect()
    await this.request(
      new BleRequest('discoverAllServicesAndCharacteristics'),
      this.peripheral.discoverAllServicesAndCharacteristicsAsync(),
      30
    )
    const serviceMap = {}
    for (const service of this.peripheral.services) {
      const serviceDelegate = this.createServiceDelegate(service)
      const map = {}
      for (const characteristic of service.characteristics) {
        const delegate = serviceDelegate.createCharacteristicDelegate(characteristic)
        if (delegate.canRead) {
          const response = await delegate.read()
          if (response.parsedValue != null) {
            map[delegate.key] = response.parsedValue
          }
        }
      }
      serviceMap[serviceDelegate.key] = map
    }
    return serviceMap
  }

  /** Execute a Bluetooth Low Energy request to a peripheral
    * @param {BleRequest} request - The request info.
    * @param {Promise} promise - The promise executing the request.
    * @param {integer} [timeout = 15] - Request timeout (in seconds).
    * @emits request
    * @emits response
    * @return {BleResponse} - The response.
    * @throws {BleError} -
    */
  async request (request, promise, timeout) {
    request.peripheralDelegate = this
    request.id = ++this.requestId
    /** Emitted when a request has been sent to the peripheral.
      * @event BleClient#request
      * @param {BleClient.BleRequest} request - The request.
      */
    this.emit('request', request)
    try {
      const response = await this.client.request(request, promise, timeout)
      if (
        request.characteristicDelegate != null &&
        response.buffer != null && response.buffer.length > 0
      ) {
        response.parsedValue = request.characteristicDelegate.f(response.buffer)
      }
      /** Emitted when a valid response has been received from the peripheral.
        * @event BleClient#response
        * @param {BleClient.BleResponse} response - The response.
        */
      this.emit('response', response)
      return response
    } catch (error) {
      this.emit('error', error)
      throw error
    }
  }

  /** Write a characteristic
    * @param {string} serviceUuid - UUID of the service.
    * @param {string} characteristicUuid - UUID of the service.
    * @returns {Buffer} - The characteristic value.
    * @throws {SyntaxError} - ...
    * @throws {BleError} - ...
    */
  async read (serviceUuid, characteristicUuid) {
    // Assert connected
    // Assert service discovered
    // Assert characteristic discovered
    // Assert characteristic is readable
    // Read characteristic
  }

  /** Write a characteristic
    * @param {string} serviceUuid - UUID of the service.
    * @param {string} characteristicUuid - UUID of the service.
    * @param {Buffer} buffer - The value to be written.
    * @throws {SyntaxError} - ...
    * @throws {BleError} - ...
    */
  async write (serviceUuid, characteristicUuid, buffer) {
    //
  }

  /** Write a characteristic
    * @param {string} serviceUuid - UUID of the service.
    * @param {string} characteristicUuid - UUID of the service.
    * @param {Buffer} buffer - The value to be written.
    * @throws {SyntaxError} - ...
    * @throws {BleError} - ...
    */
  async subscribe (serviceUuid, characteristicUuid) {
    //
  }
}

class BleServiceDelegate {
  constructor (peripheralDelegate, service) {
    this.peripheralDelegate = peripheralDelegate
    this.uuid = uuidToString(service.uuid)
    this.definition = this.peripheralDelegate.definitions[this.uuid]
    this.key = this.definition.key
    this.name = this.definition.name != null ? this.definition.name : this.key
    this.characteristicDelegates = {}
    this.service = service
  }

  get service () { return this._service }

  set service (s) {
    this._service = s
    if (s === null) {
      for (const key in this.characteristicDelegates) {
        this.characteristicDelegates[key].characteristic = null
      }
    // } else {
    //   await this.request(
    //     new BleRequest('discoverCharacteristics'),
    //     s.discoverCharacteristicsAsync([])
    //   )
    }
  }

  createCharacteristicDelegate (characteristic) {
    const uuid = uuidToString(characteristic.uuid)
    if (this.definition.characteristics[uuid] == null) {
      this.definition.characteristics[uuid] = {
        key: uuid,
        f: bufferToHex
      }
    }
    const definition = this.definition.characteristics[uuid]
    if (this.characteristicDelegates[definition.key] == null) {
      this.characteristicDelegates[definition.key] = new BleCharacteristicDelegate(
        this, characteristic
      )
    }
    return this.characteristicDelegates[definition.key]
  }

  async request (request, promise, timeout) {
    request.serviceDelegate = this
    return this.peripheralDelegate.request(request, promise, timeout)
  }
}

class BleCharacteristicDelegate {
  constructor (serviceDelegate, characteristic, definition) {
    this.peripheralDelegate = serviceDelegate.peripheralDelegate
    this.serviceDelegate = serviceDelegate
    this.uuid = uuidToString(characteristic.uuid)
    this.definition = this.serviceDelegate.definition.characteristics[this.uuid]
    this.key = this.definition.key
    this.name = this.definition.name != null ? this.definition.name : this.key
    this.f = this.definition.f != null ? this.definition.f : bufferToHex
    this.characteristic = characteristic
  }

  get characteristic () { return this._characteristic }

  set characteristic (c) {
    if (c === this._characteristic) {
      return
    }
    if (this.canNotity) {
      if (c === null) {
        this._characteristic.removeAllListeners('data')
      } else {
        c.on('data', (buffer, isNotification) => {
          if (isNotification) {
            this.peripheralDelegate.emit('notification', new BleNotification({
              serviceDelegate: this.serviceDelegate,
              characteristicDelegate: this.characteristicDelegate,
              buffer: buffer,
              value: this.f(buffer)
            }))
          }
        })
      }
    }
    this._characteristic = c
  }

  get canRead () { return this.characteristic.properties.includes('read') }

  get canWrite () { return this.characteristic.properties.includes('write') }

  get canNotify () { return this.characteristic.properties.includes('notify') }

  async read () {
    return this.request(
      new BleRequest('read ' + this.key),
      this.characteristic.readAsync()
    )
  }

  async write (buffer, withoutResponse = false) {
    return this.request(
      new BleRequest('write ' + this.key),
      this.characteristic.writeAsync(buffer, withoutResponse)
    )
  }

  async subscribe () {
    return this.request(
      new BleRequest('subscribe ' + this.key),
      this.characteristic.subscribeAsync()
    )
  }

  async request (request, promise, timeout) {
    request.characteristicDelegate = this
    return this.serviceDelegate.request(request, promise, timeout)
  }
}

module.exports = BleClient
