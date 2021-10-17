#!/usr/bin/env node

// homebridge-soma/cli/ble.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

// const events = require('events')
const homebridgeLib = require('homebridge-lib')
const BleClient = require('../lib/BleClient')
const packageJson = require('../package.json')
const { bufferToHex } = require('../lib/BleUtils')

const { b, u } = homebridgeLib.CommandLineTool
const { UsageError } = homebridgeLib.CommandLineParser

const usage = {
  ble: `${b('ble')} [${b('-hVD')}] [${b('-r')} ${u('rssi')}] [${b('-t')} ${u('timeout')}] ${u('command')} [${u('argument')} ...]`,
  discover: `${b('discover')} [${b('-h')}]`,
  probe: `${b('probe')} [${b('-h')}] ${u('id')}`
}

const description = {
  ble: 'Command line interface to Bluetooth Low Energy.',
  discover: 'Discover BLE peripherals.',
  probe: 'Probe peripheral'
}

const help = {
  ble: `${description.ble}

Usage: ${usage.ble}

Parameters:
  ${b('-h')}, ${b('--help')}
  Print this help and exit.

  ${b('-V')}, ${b('--version')}
  Print version and exit.

  ${b('-D')}, ${b('--debug')}
  Print debug messages.

  ${b('-r')} ${u('rssi')}, ${b('--rssi=')}${u('rssi')}
  Set minimum RSSI to ${u('rssi')} instead of default ${b('-100')}.

  ${b('-t')} ${u('timeout')}, ${b('--timeout=')}${u('timeout')}
  Set timeout to ${u('timeout')} seconds instead of default ${b('15')}.

Commands:
  ${usage.discover}
  ${description.discover}

  ${usage.probe}
  ${description.probe}

For more help, issue: ${b('ble')} ${u('command')} ${b('-h')}`,
  discover: `${description.discover}

Usage: ${usage.discover}

Parameters:
  ${b('-h')}, ${b('--help')}
  Print this help and exit.`,
  probe: `${description.probe}

Usage: ${usage.probe}

Parameters:
  ${b('-h')}, ${b('--help')}
  Print this help and exit.

  ${u('id')}
  ID of the device to probe.`
}

class Main extends homebridgeLib.CommandLineTool {
  constructor () {
    super()
    this.usage = usage.ble
  }

  async main () {
    try {
      this._clargs = this.parseArguments()
      this.client = new BleClient({ rssi: this._clargs.options.rssi })
      this.client
        .on('error', (error) => {
          if (error instanceof BleClient.BleError) {
            this.warn(
              'request %d: %s: %s', error.request.id, error.request.request,
              error
            )
            return
          }
          this.error(error)
        })
        .on('request', (request) => {
          this.debug('request: %d: %s', request.id, request.request)
        })
        .on('response', (response) => {
          this.debug(
            'request %d: %s: ok', response.request.id, response.request.request
          )
        })
        .on('enabled', (supported, platform, arch) => {
          this.debug('bluetooth enabled, %s on %s', platform, arch)
          if (!supported) {
            this.warn('unsupported platform, %s on %s', platform, arch)
          }
        })
        .on('disabled', () => { this.fatal('bluetooth disabled') })
        .on('scanStart', (me) => {
          this.debug('scanning started by %s', me ? 'me' : 'someone else')
        })
        .on('scanStop', (me) => {
          this.debug('scanning stopped by %s', me ? 'me' : 'someone else')
        })
        .on('deviceFound', async (device) => {
          const name = device.name != null
            ? ' [' + device.name + ']'
            : ''
          const manufacturer = device.manufacturer != null
            ? ' by ' + device.manufacturer.name
            : ''
          const address = device.address != null
            ? ' at ' + device.address
            : ''
          this.vdebug('found %s%s%s%s', device.id, name, manufacturer, address)
          this.vvdebug(
            'found %s%s%s%s %j', device.id, name, manufacturer, address,
            bufferToHex(device.manufacturerData)
          )
        })
      this.name = 'ble ' + this._clargs.command
      this.usage = `${b('ble')} ${usage[this._clargs.command]}`
      this.help = help[this._clargs.command]
      await this[this._clargs.command](this._clargs.args)
    } catch (error) {
      this.error(error)
      process.exit(-1)
    }
  }

  parseArguments () {
    const parser = new homebridgeLib.CommandLineParser(packageJson)
    const clargs = {
      options: {
        rssi: -100,
        timeout: 15
      }
    }
    parser
      .help('h', 'help', help.ble)
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
      .option('r', 'rssi', (value) => {
        clargs.options.rssi = homebridgeLib.OptionParser.toInt(
          'rssi', value, -100, -50, true
        )
      })
      .option('t', 'timeout', (value) => {
        clargs.options.timeout = homebridgeLib.OptionParser.toInt(
          'timeout', value, 1, 120, true
        )
      })
      .parameter('command', (value) => {
        if (usage[value] == null || typeof this[value] !== 'function') {
          throw new UsageError(`${value}: unknown command`)
        }
        clargs.command = value
      })
      .remaining((list) => { clargs.args = list })
      .parse()
    return clargs
  }

  createDelegate (peripheral, bleError = true) {
    const delegate = new BleClient.BlePeripheralDelegate(this.client, peripheral)
    delegate
      .on('error', (error) => {
        if (error instanceof BleClient.BleError) {
          if (bleError || this.debug) {
            this.warn(
              '%s: request %d: %s', delegate.id, error.request.id,
              error.request.request, error
            )
          }
          return
        }
        this.error('%s: %s', delegate.id, error)
      })
      .on('request', (request) => {
        this.debug('%s: request %d: %s', delegate.id, request.id, request.request)
      })
      .on('response', (response) => {
        if (response.parsedValue == null) {
          this.debug(
            '%s: request %d: %s: ok', delegate.id, response.request.id,
            response.request.request
          )
        } else {
          this.debug(
            '%s: request %d: %s: response: %j', delegate.id, response.request.id,
            response.request.request, response.parsedValue
          )
        }
        if (response.buffer != null) {
          this.vdebug(
            '%s: request %d: %s: response buffer: %j', delegate.id,
            response.request.id, response.request.request,
            bufferToHex(response.buffer)
          )
        }
      })
      .on('connected', (rssi) => {
        this.debug('%s: connected (rssi: %d)', delegate.id, rssi)
      })
      .on('disconnected', () => {
        this.debug('%s: disconnected', delegate.id)
      })
    return delegate
  }

  discover (...args) {
    const parser = new homebridgeLib.CommandLineParser(packageJson)
    parser.help('h', 'help', this.help)
    parser.parse(...args)
    // const emitter = new events.EventEmitter()
    // let jobs = 0
    this.client
      .on('deviceFound', async (device) => {
        const name = device.name != null
          ? ' [' + device.name + ']'
          : ''
        const manufacturer = device.manufacturer != null
          ? ' by ' + device.manufacturer.name
          : ''
        const delegate = this.createDelegate(device.peripheral, false)
        // if (delegate.address == null && this.client.macOs) {
        //   jobs++
        //   try {
        //     await delegate.connect()
        //     await delegate.disconnect()
        //   } catch (error) {
        //     if (!(error instanceof BleClient.BleError)) {
        //       this.warn(error)
        //     }
        //   }
        //   jobs--
        //   emitter.emit('done')
        // }
        if (delegate.address != null) {
          this.log(
            '%s:%s%s', delegate.address, name, manufacturer
          )
        }
      })
      .on('stopSearching', async () => {
        // while (jobs > 0) { // eslint-disable-line no-unmodified-loop-condition
        //   await events.once(emitter, 'done')
        // }
        process.exit(0)
      })
  }

  checkAddress (address) {
    if (address == null || address === '') {
      throw new UsageError(
        `Missing peripheral mac address.  Set ${b('BLE_PERIPHERAL')} or specify ${b('-S')}.`
      )
    } else if (!homebridgeLib.OptionParser.patterns.mac.test(address)) {
      throw new UsageError(`${address}: invalid mac address`)
    }
    return address.toUpperCase().replace(/[-]/g, ':')
  }

  probe (...args) {
    const parser = new homebridgeLib.CommandLineParser(packageJson)
    let address = process.env.BLE_PERIPHERAL
    parser
      .help('h', 'help', this.help)
      .remaining((list) => {
        if (list.length > 1) {
          throw new UsageError('too many arguments')
        }
        if (list.length === 1) {
          address = homebridgeLib.OptionParser.toString('address', list[0], true)
        }
      })
      .parse(...args)
    address = this.checkAddress(address)
    this.client.on('deviceFound', async (device) => {
      try {
        if (device.address === address) {
          await this.client.stopSearch()
          const delegate = this.createDelegate(device.peripheral)
          const map = await delegate.readAll()
          const jsonFormatter = new homebridgeLib.JsonFormatter()
          this.print(jsonFormatter.stringify(map))
          await delegate.disconnect()
          process.exit(0)
        }
      } catch (error) {
        if (!(error instanceof BleClient.BleError)) {
          this.warn(error)
        }
        process.exit(-1)
      }
    })
  }
}

new Main().main()
