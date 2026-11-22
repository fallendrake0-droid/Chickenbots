'use strict'
const shellEnvironment = { ...process.env }
require('dotenv').config({ quiet: true })
const readline = require('readline')
const { loadConfig } = require('./src/config')
const Logger = require('./src/logger')
const { Manager } = require('./src/manager')
const dashboard = require('./src/dashboard')
const { editConfig } = require('./src/configEditor')
async function main () {
  const config = loadConfig(process.env); const log = new Logger(config); const manager = new Manager(config, log); const web = dashboard(manager)
  console.log('\n╔══════════════════════════════════════════════╗\n║          C H I C K E N B O T S               ║\n║        FIVE-BOT CONTROL CENTRE               ║\n╚══════════════════════════════════════════════╝')
  log.log('SYSTEM', 'info', `Target: ${config.host}:${config.port}`)
  await web.listen(); log.log('SYSTEM', 'success', `Dashboard: http://${config.dashboardHost}:${config.dashboardPort}`); manager.all('start')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
  let closing = false
  let editing = false
  async function shutdown () { if (closing) return; closing = true; rl.close(); manager.shutdown(); await web.close(); log.log('SYSTEM', 'info', 'Shutdown complete') }
  rl.on('line', line => { if (editing) return; const [cmd, ...args] = line.trim().split(/\s+/); try { if (cmd === 'help') console.log('help | config | status | server | ping | start [bot|all] | stop [bot|all] | reconnect [bot|all] | chat <bot> <message> | clear | exit')
    else if (cmd === 'config') { editing = true; editConfig(rl, { overrides: shellEnvironment }).catch(err => log.log('SYSTEM', 'error', err.message)).finally(() => { editing = false }) }
    else if (cmd === 'status') console.log(manager.snapshot().bots.map(b => `${b.name}: ${b.state} / ${b.auth}`).join('\n'))
    else if (cmd === 'server') console.log(`${config.host}:${config.port}`)
    else if (cmd === 'ping') console.log(manager.snapshot().bots.map(b => `${b.name}: ${b.ping ?? 'unavailable'} ms`).join('\n'))
    else if (cmd === 'clear') console.clear()
    else if (cmd === 'exit') void shutdown()
    else if (['start', 'stop', 'reconnect'].includes(cmd)) { const name = args[0] || 'all'; if (name === 'all') manager.all(cmd); else { const c = manager.controllers.get(name); if (!c) throw new Error('Unknown bot'); c[cmd]() } }
    else if (cmd === 'chat') { const c = manager.controllers.get(args.shift()); if (!c) throw new Error('Unknown bot'); c.chat(args.join(' ')) }
    else if (cmd) console.log('Unknown command. Type help.')
  } catch (e) { log.log('SYSTEM', 'error', e.message) } })
  rl.on('SIGINT', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() }); process.once('SIGTERM', () => { void shutdown() })
}
main().catch(err => { console.error(`[ERROR] ${err.message}`); process.exitCode = 1 })
