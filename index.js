'use strict'
const shellEnvironment = { ...process.env }
const readline = require('readline')
const Logger = require('./src/logger')
const { Manager } = require('./src/manager')
const dashboard = require('./src/dashboard')
const { editConfig } = require('./src/configEditor')
const Terminal = require('./src/terminal')
const { startup } = require('./src/startup')
async function main () {
  const terminal = new Terminal(); const config = await startup(terminal, shellEnvironment); if (!config) return
  const log = new Logger(config); log.output = (line, level) => terminal.log(line, level); const manager = new Manager(config, log); manager.deviceLogin = message => terminal.write(message); const web = dashboard(manager)
  terminal.clear()
  terminal.banner(config)
  log.log('SYSTEM', 'info', `Target: ${config.host}:${config.port}`)
  await web.listen(); log.log('SYSTEM', 'success', `Dashboard: http://${config.dashboardHost}:${config.dashboardPort}`); manager.all('start')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
  terminal.attach(rl)
  terminal.prompt()
  let closing = false
  let editing = false
  async function shutdown () { if (closing) return; closing = true; rl.close(); manager.shutdown(); await web.close(); log.log('SYSTEM', 'info', 'Shutdown complete') }
  rl.on('line', line => { if (editing) return; const [cmd, ...args] = line.trim().split(/\s+/); try { if (cmd === 'help') terminal.help()
    else if (cmd === 'config') { editing = true; terminal.setEditing(true); editConfig(rl, { overrides: shellEnvironment }).catch(err => log.log('SYSTEM', 'error', err.message)).finally(() => { editing = false; terminal.setEditing(false); terminal.prompt() }) }
    else if (cmd === 'status') terminal.status(manager.snapshot())
    else if (cmd === 'server') terminal.write(`SERVER  ${config.host}:${config.port}`)
    else if (cmd === 'ping') terminal.write(manager.snapshot().bots.map(b => `${b.name}: ${b.ping == null ? 'unavailable' : `${b.ping} ms`}`).join('\n'))
    else if (cmd === 'clear') { console.clear(); terminal.banner(config) }
    else if (cmd === 'exit') void shutdown()
    else if (['start', 'stop', 'reconnect'].includes(cmd)) { const name = args[0] || 'all'; if (name === 'all') manager.all(cmd); else { const c = manager.controllers.get(name); if (!c) throw new Error('Unknown bot'); c[cmd]() } }
    else if (cmd === 'chat') { const c = manager.controllers.get(args.shift()); if (!c) throw new Error('Unknown bot'); c.chat(args.join(' ')) }
    else if (cmd) terminal.write('Unknown command. Type help.')
  } catch (e) { log.log('SYSTEM', 'error', e.message) } finally { if (!editing && !closing) terminal.prompt() } })
  rl.on('SIGINT', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() }); process.once('SIGTERM', () => { void shutdown() })
}
main().catch(err => { console.error(`[ERROR] ${err.message}`); process.exitCode = 1 })
