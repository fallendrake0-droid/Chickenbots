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
  log.log('SYSTEM', 'info', `Account authentication: ${config.auth}${config.auth === 'offline' ? ' (use only on servers that permit offline identities)' : ''}`)
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
    else if (cmd === 'survival') { const [name, setting, ...values] = args; const targets = name === 'all' ? [...manager.controllers.values()] : [manager.controllers.get(name)]; if (targets.some(c => !c)) throw new Error('Unknown bot'); if (setting === 'armour' || setting === 'eat') { if (values.length !== 1 || !['on','off'].includes(values[0])) throw new Error('Use on or off'); for (const c of targets) { if (setting === 'armour') c.survival.setAutoArmour(values[0] === 'on'); else c.work.setAutoEat(values[0] === 'on') } } else if (setting === 'food') { if (values.length !== 3 || !/^\d+$/.test(values[0]) || !/^\d+$/.test(values[1])) throw new Error('Use survival <bot|all> food <threshold> <reserve> <balanced|saturation|cheap>'); const settings = require('./src/food').validateFoodSettings({threshold:Number(values[0]), reserve:Number(values[1]), priority:values[2]}); for (const c of targets) c.work.setFoodSettings(settings) } else throw new Error('Use survival <bot|all> <armour|eat|food> ...'); terminal.write('Survival setting updated (in memory).') }
    else if (cmd === 'player') { const [name, command, player, item, count] = args; if (command === 'drop' && (!count || !/^\d+$/.test(count))) throw new Error('Use player <bot> drop <player> <item> <count>'); const result = require('./src/players').playerCommand(manager, name, command, {player, item, count:Number(count)}); terminal.write(result ? `Player action: ${result.started.join(', ') || 'none'}; skipped: ${result.skipped.join('; ') || 'none'}` : 'Player action accepted; check status for the result.') }
    else if (cmd === 'mine') { const [name, ore] = args; const { ORES } = require('./src/work'); if (args.length !== 2 || !ORES.includes(ore)) throw new Error('Use mine <bot|all> <coal|copper|iron|gold|redstone|lapis|diamond|emerald>'); if (name === 'all') manager.team.start(`ore_${ore}`); else { const c = manager.controllers.get(name); if (!c) throw new Error('Unknown bot'); if (manager.team.job?.state === 'RUNNING') throw new Error('Stop the team task before starting individual work'); c.work.start(`ore_${ore}`) } }
    else if (cmd === 'chat') { const c = manager.controllers.get(args.shift()); if (!c) throw new Error('Unknown bot'); c.chat(args.join(' ')) }
    else if (cmd) terminal.write('Unknown command. Type help.')
  } catch (e) { log.log('SYSTEM', 'error', e.message) } finally { if (!editing && !closing) terminal.prompt() } })
  rl.on('SIGINT', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() }); process.once('SIGTERM', () => { void shutdown() })
}
main().catch(err => { console.error(`[ERROR] ${err.message}`); process.exitCode = 1 })
