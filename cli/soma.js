#!/usr/bin/env node

// homebridge-soma/cli/soma.js
// Copyright © 2021 Erik Baauw. All rights reserved.
//
// Homebridge plug-in for SOMA devices.

'use strict'

const homebridgeLib = require('homebridge-lib')
const SomaClient = require('../lib/SomaClient')
const packageJson = require('../package.json')
const { bufferToHex } = require('../lib/BleUtils')

const { b, u } = homebridgeLib.CommandLineTool
const { UsageError } = homebridgeLib.CommandLineParser

const usage = {
  soma: `${b('soma')} [${b('-hVD')}] [${b('-t')} ${u('timeout')}] ${u('command')} [${u('argument')} ...]`,
  discover: `${b('discover')} [${b('-h')}]`,
  probe: `${b('probe')} [${b('-h')}] ${u('device')}`,

  info: `${b('info')} [${b('-h')}] ${u('device')}`,
  open: `${b('open')} [${b('-h')}] ${u('device')}`,
  close: `${b('close')} [${b('-h')}] ${u('device')} [${b('down')}|${b('up')}]`,
  stop: `${b('stop')} [${b('-h')}] ${u('device')}`,

  position: `${b('position')} [${b('-hm')}] ${u('device')} [${b('--')}] [${u('position')}]`
}

const description = {
  soma: 'Command line interface to SOMA devices.',
  discover: 'Discover SOMA devices.',
  probe: 'Probe device.',

  info: 'Get device info.',
  open: 'Open device',
  close: 'Close device',
  stop: 'Stop current movement.',

  position: 'Get or set position.'
}

const help = {
  soma: `${description.soma}

Usage: ${usage.soma}

Parameters:
  ${b('-h')}, ${b('--help')}
  Print this help and exit.

  ${b('-V')}, ${b('--version')}
  Print version and exit.

  ${b('-D')}, ${b('--debug')}
  Print debug messages.

  ${b('-t')} ${u('timeout')}, ${b('--timeout=')}${u('timeout')}
  Set timeout to ${u('timeout')} seconds instead of default ${b('15')}.

Commands:
  ${usage.discover}
  ${description.discover}

  ${usage.probe}
  ${description.probe}

  ${usage.info}
  ${description.info}

  ${usage.open}
  ${description.open}

  ${usage.close}
  ${description.close}

  ${usage.stop}
  ${description.stop}

  ${usage.position}
  ${description.position}

For more help, issue: ${b('soma')} ${u('command')} ${b('-h')}`,
  discover: `${description.discover}

Usage: ${b('soma')} ${usage.discover}

Parameters:
  ${b('-h')}, ${b('--help')}
  Print this help and exit.`,
  probe: `${description.probe}

Usage: ${b('soma')} ${usage.probe}

Parameters:
  ${b('-h')}, ${b('--help')}
  Print this help and exit.

  ${u('device')}
  Display name or mac address of the device to probe.`
}

class Main extends homebridgeLib.CommandLineTool {
  constructor () {
    super()
    this.usage = usage.soma
  }

  async main () {
    try {
      this._clargs = this.parseArguments()
      this.client = new SomaClient()
      this.client
        .on('error', (error) => {
          if (error instanceof SomaClient.BleError) {
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
        .on('shadeFound', async (device) => {
          const name = device.name != null
            ? ' [' + device.name + ']'
            : ''
          const manufacturer = device.manufacturer != null
            ? ' by ' + device.manufacturer.name
            : ''
          const address = device.address != null
            ? ' at ' + device.address
            : ''
          this.vdebug(
            'found %s%s%s%s %j', device.id, name, manufacturer, address,
            device.data
          )
          this.vvdebug(
            'found %s%s%s%s %j', device.id, name, manufacturer, address,
            bufferToHex(device.manufacturerData)
          )
        })
      this.name = 'soma ' + this._clargs.command
      this.usage = `${b('soma')} ${usage[this._clargs.command]}`
      this.help = help[this._clargs.command]
      await this[this._clargs.command](this._clargs.args)
      process.exit(0)
    } catch (error) {
      if (!(error instanceof SomaClient.BleError)) {
        this.error(error)
      }
      process.exit(-1)
    }
  }

  parseArguments () {
    const parser = new homebridgeLib.CommandLineParser(packageJson)
    const clargs = {
      options: {
        timeout: 15
      }
    }
    parser
      .help('h', 'help', help.soma)
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

  createDelegate (device, bleError = true) {
    const delegate = new SomaClient.SomaPeripheral(this.client, device)
    delegate
      .on('error', (error) => {
        if (error instanceof SomaClient.BleError) {
          if (bleError || this.debug) {
            this.warn(
              '%s: request %d: %s: %s', delegate.id, error.request.id,
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
      .on('connected', () => {
        this.debug('%s: connected', delegate.id)
      })
      .on('disconnected', () => {
        this.debug('%s: disconnected', delegate.id)
      })
      .on('notification', (notification) => {
        this.vdebug(
          'notification: %s/%s: %s', notification.serviceKey,
          notification.key, bufferToHex(notification.buffer)
        )
        this.debug(
          'notification: %s/%s: %j', notification.serviceKey,
          notification.key, notification.parsedValue
        )
      })

    return delegate
  }

  async discover (...args) {
    const parser = new homebridgeLib.CommandLineParser(packageJson)
    parser.help('h', 'help', this.help)
    parser.parse(...args)
    const found = {}
    this.client
      .on('shadeFound', async (device) => {
        if (found[device.id] == null) {
          found[device.id] = device
          const type = device.data.supportsUp ? 'Tilt' : 'Smart Shades'
          this.log(
            '%s: %s (%s), position: %j%%, battery: %j%%',
            device.address, device.data.displayName, type,
            device.data.currentPosition, device.data.battery
          )
        }
      })
    return homebridgeLib.timeout(this._clargs.options.timeout * 1000)
  }

  async find (address = process.env.SOMA_DEVICE) {
    if (address == null || address === '') {
      throw new UsageError(
        `Missing device name or mac address.  Set ${b('SOMA_DEVICE')} or specify ${b('-S')}.`
      )
    } else if (homebridgeLib.OptionParser.patterns.mac.test(address)) {
      address = address.toUpperCase().replace(/[-]/g, ':')
    }
    return new Promise((resolve, reject) => {
      let found = false
      const timer = setTimeout(() => {
        reject(new Error(`${address}: device not found`))
      }, this._clargs.options.timeout * 1000)
      this.client.on('shadeFound', async (device) => {
        try {
          if ((device.address === address || device.data.displayName === address) && !found) {
            found = true
            clearTimeout(timer)
            resolve(this.createDelegate(device))
          }
        } catch (error) {
          if (!(error instanceof SomaClient.BleError)) {
            this.warn(error)
          }
        }
      })
    })
  }

  async _parse (...args) {
    let address
    const parser = new homebridgeLib.CommandLineParser(packageJson)
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
    return this.find(address)
  }

  async probe (...args) {
    const delegate = await this._parse(...args)
    const map = await delegate.readAll()
    await delegate.disconnect()
    const jsonFormatter = new homebridgeLib.JsonFormatter()
    this.print(jsonFormatter.stringify(map))
  }

  async info (delegate) {

  }

  async open (...args) {
    const delegate = await this._parse(...args)
    await delegate.open()
  }

  async close (...args) {

  }
}

new Main().main()
