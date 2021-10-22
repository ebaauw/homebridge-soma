// homebridge-soma/lib/BleClient.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const events = require('events')
const fs = require('fs').promises
const homebridgeLib = require('homebridge-lib')
const noble = require('@homebridge/noble')
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
  constructor (request, response) {
    /** @member {BleRequest} - The request that generated the response.
      * See {@link BleClient.BleRequest BleRequest}.
      */
    this.request = request
    /** @member {*} - The response to the request.
      */
    this.response = response
    if (Buffer.isBuffer(response)) {
      /** @member {?Buffer} - The response to the request.
        */
      this.buffer = response
      /** @member {?*} - The parsed response to the request.
        */
      this.parsedValue = bufferToHex(response)
    } else if (Array.isArray(response)) {
      if (request.request.endsWith(': notification')) {
        this.buffer = response[0].buffer
        this.parsedValue = response[0].parsedValue
      } else {
        this.parsedValue = response.map((element) => {
          return element.uuid == null ? element : uuidToString(element.uuid)
        })
      }
    }
  }
}

/** Bluetooth Low Energy notification.
  * @hideconstructor
  * @memberof BleClient
  */
class BleNotification {
  constructor (serviceKey, key, buffer, value) {
    /** @member {string} - The delegate for the service.
      */
    this.serviceKey = serviceKey
    /** @member {BleCharacteristicDelegate} - The delegate for the characteristic.
      */
    this.key = key
    /** @member {Buffer} - The raw value.
      */
    this.buffer = buffer
    /** @member {*} - The parsed value.
      */
    this.parsedValue = value
  }
}

class SafeEventEmitter extends events.EventEmitter {
  emit (event, ...args) {
    try {
      super.emit(event, ...args)
    } catch (error) {
      super.emit('error', error)
    }
  }
}

class BleClient extends SafeEventEmitter {
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
    * @param {integer} [params.rssi = -100] - Minimum RSSI value for disovered peripherals.
    * @param {integer} [params.scanTimeout = 120] - Scanning duration (in seconds).
    * @param {integer} [params.timeout = 15] - Request timeout (in seconds).
    * Set to 0 for continuous scanning.
    */
  constructor (params = {}) {
    super()

    // FIXME parameter checking
    this.allowDuplicates = params.allowDuplicates || false
    this.rssi = params.rssi != null ? params.rssi : -100
    this.scanDuration = params.scanDuration != null ? params.scanDuration : 30
    this.timeout = params.timeout != null ? params.timeout : 15

    this.requestId = 0

    noble
      .on('warning', (message) => { this.emit('error', new Error(message)) })
      .on('stateChange', async (newState) => {
        try {
          await this.checkPlatform()
          this._state = newState
          if (this.enabled) {
            /** Emitted when bluetooth is enabled.
              * @event BleClient#enabled
              */
            this.emit('enabled', this.supported, this.platform, this.arch)
            await this.search()
          } else {
            /** Emitted when bluetooth is disabled.
              * @event BleClient#disabled
              */
            this.emit('disabled')
            this.scanning = false
            this.startScanning = false
          }
        } catch (error) { this.emit('error', error) }
      })
      .on('scanStart', () => {
        try {
          if (this.scanning) {
            return
          }
          this.scanning = true
          /** Emitted when searching for Bluetooth peripherals.
            * @event BleClient#searching
            */
          this.emit('scanStart', this.startScanning)
          if (this.startScanning) {
            if (this.scanDuration > 0) {
              this.scanTimer = setTimeout(async () => {
                try {
                  this.scanTimer = null
                  await this.stopSearch()
                } catch (error) { this.emit(error) }
              }, this.scanDuration * 1000)
            }
            this.startScanning = false
          }
        } catch (error) { this.emit('error', error) }
      })
      .on('scanStop', async () => {
        try {
          if (!this.scanning) {
            return
          }
          this.scanning = false
          if (this.scanTimer != null) {
            clearTimeout(this.scanTimer)
            delete this.scanTimer
          }
          /** Emitted when no longer searching for Bluetooth peripherals.
            * @event BleClient#stopSearching
            */
          this.emit('scanStop', this.stopScanning)
          if (this.stopScanning) {
            this.stopScanning = false
          } else if (this.scanDuration === 0) {
            await homebridgeLib.timeout(1000)
            await this.search()
          }
        } catch (error) { this.emit('error', error) }
      })
      .on('discover', (peripheral) => {
        try {
          if (peripheral.connectable && peripheral.rssi >= this.rssi) {
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
              manufacturerData: peripheral.advertisement.manufacturerData,
              name: peripheral.advertisement.localName,
              peripheral: peripheral
            })
          }
        } catch (error) { this.emit('error', error) }
      })
  }

  async checkPlatform () {
    if (this.platform == null) {
      this.platform = os.platform()
      this.arch = os.arch()
      if (this.platform === 'darwin' && this.arch === 'x64') {
        this.platform = 'macOS'
        this.macOs = true
      }
      if (this.platform === 'linux' && ['arm', 'arm64'].includes(this.arch)) {
        try {
          await fs.access('/usr/bin/vcgencmd')
          this.platform = 'Raspberry Pi OS'
          this.piOs = true
          this.supported = true
        } catch (error) {}
      }
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
    if (this.scanning || this.startScanning) {
      return
    }
    this.startScanning = true
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
    if (!this.scanning || this.stopScanning) {
      return
    }
    this.stopScanning = true
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
          peripheralDelegate.removeListener('disconnected', onDisconnect)
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
          peripheralDelegate.removeListener('disconnected', onDisconnect)
        }
        reject(new BleError(new BleError('bluetooth disabled'), request))
      }

      // Setup guard for peripheral disconnect.
      const self = this
      function onDisconnect () {
        clearTimeout(timer)
        self.removeListener('disabled', onDisabled)
        reject(new BleError('disconnected unexpectedly', request))
      }

      if (peripheralDelegate == null) {
        /** Emitted when a request has been sent.
          * @event BleClient#request
          * @param {BleClient.BleRequest} request - The request.
          */
        request.id = ++this.requestId
        this.emit('request', request)
      } else if (request.request !== 'disconnect') {
        peripheralDelegate.once('disconnected', onDisconnect)
      }
      this.once('disabled', onDisabled)

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
            peripheralDelegate.removeListener('disconnected', onDisconnect)
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
            minimumConnectionInterval: b.readUInt16LE(0),
            maximumConnectionInterval: b.readUInt16LE(2),
            slaveLatency: b.readUInt16LE(4),
            connectionSupervisionTimeoutMultiplier: b.readUInt16LE(6)
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
            startOfAffectedAttributeHandleRange: b.readUInt16LE(0),
            endOfAffectedAttributeHandleRange: b.readUInt16LE(2)
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

class BlePeripheralDelegate extends SafeEventEmitter {
  constructor (client, peripheral, uuidDefinitions = {}) {
    super()
    this.requestId = 0
    this.client = client
    this.peripheral = peripheral
    this.id = this.peripheral.id
    this.address = this.peripheral.address !== ''
      ? this.peripheral.address.replace(/-/g, ':').toUpperCase()
      : null
    this.peripheral
      .on('connect', () => {
        try {
          if (this.address == null) {
            this.address = this.peripheral.address !== ''
              ? peripheral.address.replace(/-/g, ':').toUpperCase()
              : null
          }
          /** Emitted when peripheral has connected.
            * @event BleClient#connected
            * @paramter {integer} rssi
            */
          this.emit('connected', this.peripheral.rssi)
          if (this.connectionDuration !== 0) {
            this.connectionTimer = setTimeout(async () => {
              try {
                this.connectionTimer = null
                await this.disconnect()
              } catch (error) { this.emit(error) }
            }, this.connectionDuration * 1000)
          }
        } catch (error) { this.emit('error', error) }
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
    this.connectionDuration = 120 // FIXME: make parameter
    // this.serviceDelegates = {}
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

  destroy () {
    this.peripheral.removeAllListeners()
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
            await this.disconnect()
          } catch (error) { this.emit('error', error) }
        }, this.connectionDuration * 1000)
      }
      return
    }
    await this.request(
      new BleRequest('connect'),
      this.peripheral.connectAsync()
    )
    if (this.serviceDelegates == null) {
      try {
        this.serviceDelegates = {}
        await this.request(
          new BleRequest('discoverAllServicesAndCharacteristics'),
          this.peripheral.discoverAllServicesAndCharacteristicsAsync(),
          30
        )
        // await this.request(
        //   new BleRequest('discoverServices'),
        //   this.peripheral.discoverServicesAsync()
        // )
        for (const service of this.peripheral.services) {
          const serviceDelegate = this.createServiceDelegate(service)
          // await serviceDelegate.request(
          //   new BleRequest('discoverCharacteristics'),
          //   service.discoverCharacteristicsAsync()
          // )
          for (const characteristic of service.characteristics) {
            serviceDelegate.createCharacteristicDelegate(characteristic)
          }
        }
      } catch (error) {
        delete this.serviceDelegates
        throw error
      }
    }
  }

  async disconnect () {
    if (this.peripheral.state === 'connected') {
      return this.request(
        new BleRequest('disconnect'),
        this.peripheral.disconnectAsync()
      )
    }
  }

  async readAll () {
    await this.connect()
    const map = {}
    for (const key in this.serviceDelegates) {
      map[key] = await this.serviceDelegates[key].readAll()
    }
    return map
  }

  /** Write a characteristic
    * @param {string} serviceKey - UUID of the service.
    * @param {string} characteristicKey - UUID of the service.
    * @returns {Buffer} - The characteristic value.
    * @throws {SyntaxError} - ...
    * @throws {BleError} - ...
    */
  async read (serviceKey, characteristicKey) {
    await this.connect()
    const delegate = this.serviceDelegates[serviceKey]
    if (delegate == null) {
      throw new RangeError(`${serviceKey}: unknown service key`)
    }
    return delegate.read(characteristicKey)
  }

  /** Write a characteristic
    * @param {string} serviceKey - UUID of the service.
    * @param {string} characteristicUuid - UUID of the service.
    * @param {Buffer} buffer - The value to be written.
    * @param {boolean} [withoutResponse = false] - Write without response.
    * @throws {SyntaxError} - ...
    * @throws {BleError} - ...
    */
  async write (serviceKey, characteristicKey, buffer, withoutResponse = false) {
    await this.connect()
    if (this.serviceDelegates[serviceKey] == null) {
      throw new RangeError(`${serviceKey}: unknown service key`)
    }
    return this.serviceDelegates[serviceKey].write(
      characteristicKey, buffer, withoutResponse
    )
  }

  /** Subscribe to characteristic notifications.
    * @param {string} serviceKey - UUID of the service.
    * @param {string} characteristicKey - UUID of the service.
    * @throws {SyntaxError} - ...
    * @throws {BleError} - ...
    */
  async subscribe (serviceKey, characteristicKey) {
    await this.connect()
    if (this.serviceDelegates[serviceKey] == null) {
      throw new RangeError(`${serviceKey}: unknown service key`)
    }
    return this.serviceDelegates[serviceKey].subscribe(characteristicKey)
  }

  /** Wait for a characteristic notification.
    * @param {string} serviceKey - UUID of the service.
    * @param {string} characteristicKey - UUID of the service.
    * @throws {SyntaxError} - ...
    * @throws {BleError} - ...
    */
  async notification (serviceKey, characteristicKey) {
    await this.connect()
    if (this.serviceDelegates[serviceKey] == null) {
      throw new RangeError(`${serviceKey}: unknown service key`)
    }
    return this.serviceDelegates[serviceKey].notification(characteristicKey)
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
        try {
          response.parsedValue = request.characteristicDelegate.f(response.buffer)
        } catch (error) {}
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
}

class BleServiceDelegate {
  constructor (peripheralDelegate, service) {
    this.peripheralDelegate = peripheralDelegate
    this.client = this.peripheralDelegate.client
    this.uuid = uuidToString(service.uuid)
    this.definition = this.peripheralDelegate.definitions[this.uuid]
    this.key = this.definition.key
    this.name = this.definition.name != null ? this.definition.name : this.key
    this.characteristicDelegates = {}
    this.service = service
    this._uuid = service.uuid
  }

  get service () { return this._service }

  set service (s) {
    this._service = s
    if (s === null) {
      for (const key in this.characteristicDelegates) {
        this.characteristicDelegates[key].characteristic = null
      }
    }
  }

  async discover () {
    await this.peripheralDelegate.connect()
    if (this.service == null) {
      await this.peripheralDelegate.request(
        new BleRequest('discoverService ' + this.key),
        this.peripheralDelegate.peripheral.discoverServicesAsync([this._uuid])
      )
      for (const service of this.peripheralDelegate.peripheral.services) {
        if (service.uuid === this._uuid) {
          this.service = service
          break
        }
      }
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

  async readAll () {
    const map = {}
    for (const key in this.characteristicDelegates) {
      const delegate = this.characteristicDelegates[key]
      await this.discover()
      await delegate.discover()
      if (delegate.canRead) {
        const response = await delegate.read()
        if (response.parsedValue != null) {
          map[key] = response.parsedValue
        }
      }
    }
    return map
  }

  async read (characteristicKey) {
    await this.discover()
    const delegate = this.characteristicDelegates[characteristicKey]
    if (delegate == null) {
      throw new RangeError(`${characteristicKey}: unknown characteristic key`)
    }
    return delegate.read()
  }

  async write (characteristicKey, buffer, withoutResponse = false) {
    await this.discover()
    const delegate = this.characteristicDelegates[characteristicKey]
    if (delegate == null) {
      throw new RangeError(`${characteristicKey}: unknown characteristic key`)
    }
    return delegate.write(buffer, withoutResponse)
  }

  async subscribe (characteristicKey) {
    await this.discover()
    const delegate = this.characteristicDelegates[characteristicKey]
    if (delegate == null) {
      throw new RangeError(`${characteristicKey}: unknown characteristic key`)
    }
    return delegate.subscribe()
  }

  async notification (characteristicKey) {
    await this.discover()
    const delegate = this.characteristicDelegates[characteristicKey]
    if (delegate == null) {
      throw new RangeError(`${characteristicKey}: unknown characteristic key`)
    }
    return delegate.notification()
  }

  async request (request, promise, timeout) {
    request.request = this.key + ': ' + request.request
    request.serviceDelegate = this
    return this.peripheralDelegate.request(request, promise, timeout)
  }
}

class BleCharacteristicDelegate {
  constructor (serviceDelegate, characteristic, definition) {
    this.peripheralDelegate = serviceDelegate.peripheralDelegate
    this.client = this.peripheralDelegate.client
    this.serviceDelegate = serviceDelegate
    this.uuid = uuidToString(characteristic.uuid)
    this.definition = this.serviceDelegate.definition.characteristics[this.uuid]
    this.key = this.definition.key
    this.name = this.definition.name != null ? this.definition.name : this.key
    this.f = this.definition.f != null ? this.definition.f : bufferToHex
    this.characteristic = characteristic
    this._uuid = characteristic.uuid
    this.canRead = this.characteristic.properties.includes('read')
    this.canWrite = this.characteristic.properties.includes('write')
    this.canNotify = this.characteristic.properties.includes('notify')
  }

  get characteristic () { return this._characteristic }

  set characteristic (c) {
    if (c === this._characteristic) {
      return
    }
    if (c === null) {
      this._characteristic.removeAllListeners('data')
    }
    this._characteristic = c
    if (c != null && this.canNotify) {
      c.on('data', (buffer, isNotification) => {
        try {
          if (isNotification) {
            let parsedValue
            try {
              parsedValue = this.f(buffer)
            } catch (error) { this.peripheralDelegate.emit('error', error) }
            const notification = new BleNotification(
              this.serviceDelegate.key, this.key, buffer, parsedValue
            )
            this.peripheralDelegate.emit('notification', notification)
            const event = this.serviceDelegate.key + '/' + this.key
            this.peripheralDelegate.emit(event, notification)
          }
        } catch (error) { this.peripheralDelegate.emit('error', error) }
      })
    }
  }

  async discover () {
    if (this.characteristic == null) {
      await this.serviceDelegate.request(
        new BleRequest('discoverCharacteristic ' + this.key),
        this.serviceDelegate.service.discoverCharacteristicsAsync([this._uuid])
      )
      for (const characteristic of this.serviceDelegate.service.characteristics) {
        if (characteristic.uuid === this._uuid) {
          this.characteristic = characteristic
          break
        }
      }
    }
  }

  async read () {
    await this.discover()
    if (!this.canRead) {
      throw new SyntaxError(`${this.key}: characteristic does not support read`)
    }
    const result = await this.request(
      new BleRequest('read'),
      this.characteristic.readAsync()
    )
    if (this.client.macOs) {
      await this.peripheralDelegate.disconnect()
    }
    return result
  }

  async write (buffer, withoutResponse = false) {
    await this.discover()
    if (!this.canWrite) {
      throw new SyntaxError(`${this.key}: characteristic does not support writa`)
    }
    const result = await this.request(
      new BleRequest('write ' + bufferToHex(buffer)),
      this.characteristic.writeAsync(buffer, withoutResponse)
    )
    if (this.client.macOs) {
      await this.peripheralDelegate.disconnect()
    }
    return result
  }

  async subscribe () {
    await this.discover()
    if (!this.canNotify) {
      throw new SyntaxError(`${this.key}: characteristic does not support notify`)
    }
    return this.request(
      new BleRequest('subscribe'),
      this.characteristic.subscribeAsync()
    )
  }

  async notification () {
    await this.discover()
    if (!this.canNotify) {
      throw new SyntaxError(`${this.key}: characteristic does not support notify`)
    }
    const key = this.serviceDelegate.key + '/' + this.key
    return this.request(
      new BleRequest('notification'),
      events.once(this.peripheralDelegate, key)
    )
  }

  async request (request, promise, timeout) {
    request.request = this.key + ': ' + request.request
    request.characteristicDelegate = this
    return this.serviceDelegate.request(request, promise, timeout)
  }
}

module.exports = BleClient
