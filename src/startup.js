'use strict'
const readline = require('readline')
const dotenv = require('dotenv')
const { readEnv, editConfig, promptPluginPassword } = require('./configEditor')
const { loadConfig } = require('./config')

function choice (input, output) {
  return new Promise(resolve => {
    const wasRaw = input.isRaw
    readline.emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    const done = result => { input.removeListener('keypress', keypress); input.setRawMode(!!wasRaw); input.pause(); output.write('\n'); resolve(result) }
    const keypress = (character, key = {}) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return done('quit')
      if (key.name === 'return' || key.name === 'enter') return done('start')
      if (character?.toLowerCase() === 'e') return done('edit')
    }
    input.on('keypress', keypress)
  })
}

async function startup (terminal, shellEnvironment, input = process.stdin, output = process.stdout) {
  terminal.clear()
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    require('dotenv').config({ quiet: true })
    return loadConfig(process.env)
  }
  while (true) {
    terminal.banner()
    output.write(` ${terminal.paint('[ ENTER ]', '1;92')} START BOTS     ${terminal.paint('[ E ]', '1;36')} EDIT CONFIG     ${terminal.paint('[ CTRL+C ]', '2')} EXIT\n > `)
    const selected = await choice(input, output)
    if (selected === 'quit') return null
    if (selected === 'edit') {
      const rl = readline.createInterface({ input, output, terminal: true })
      rl.on('SIGINT', () => rl.close())
      try { await editConfig(rl, { overrides: shellEnvironment, startup: true }) } catch (err) {
        output.write(`[ERROR] ${err.message}\n`)
        if (rl.closed) return null
      } finally { rl.close() }
      continue
    }
    try {
      // Offer a secure first-run prompt instead of failing when only the plugin password is missing.
      const values = { ...dotenv.parse(readEnv('.env')), ...shellEnvironment }
      if ((values.BOT_AUTH_ENABLED ?? 'true') === 'true' && (!values.BOT_AUTH_PASSWORD || /\s/.test(values.BOT_AUTH_PASSWORD))) {
        const rl = readline.createInterface({ input, output, terminal: true })
        rl.on('SIGINT', () => rl.close())
        try { await promptPluginPassword(rl, { overrides: shellEnvironment }) } catch (err) {
          if (rl.closed) return null
          throw err
        } finally { rl.close() }
      }
      // Validate afresh after editing, while preserving shell environment precedence.
      const config = loadConfig({ ...dotenv.parse(readEnv('.env')), ...shellEnvironment })
      dotenv.config({ quiet: true })
      return config
    } catch (err) {
      output.write(`\n[ERROR] ${err.message}\nPress E to edit your configuration.\n\n`)
    }
  }
}
module.exports = { startup, choice }
