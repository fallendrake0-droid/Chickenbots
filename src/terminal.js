'use strict'
const readline = require('readline')

class Terminal {
  constructor (output = process.stdout, env = process.env) {
    this.output = output
    this.colour = !!output.isTTY && env.TERM !== 'dumb' && !Object.hasOwn(env, 'NO_COLOR')
    this.rl = null
    this.editing = false
    this.pending = []
  }
  paint (text, code) { return this.colour ? `\x1b[${code}m${text}\x1b[0m` : text }
  attach (rl) { this.rl = rl; if (rl.terminal) rl.setPrompt('chickenbots > ') }
  prompt () { if (this.rl?.terminal && !this.rl.closed && !this.editing) this.rl.prompt(true) }
  write (text) {
    if (this.editing) { this.pending.push(text); if (this.pending.length > 500) this.pending.shift(); return }
    const interactive = this.rl?.terminal && !this.rl.closed
    if (interactive) { readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0) }
    this.output.write(text + '\n')
    if (interactive) this.prompt()
  }
  setEditing (editing) {
    this.editing = editing
    if (!editing) { const pending = this.pending.splice(0); for (const line of pending) this.write(line) }
  }
  banner (config) {
    const accent = s => this.paint(s, '1;92'); const dim = s => this.paint(s, '2'); const cyan = s => this.paint(s, '36')
    const wide = !this.output.columns || this.output.columns >= 65
    const title = wide
      ? ['  ██████╗██╗  ██╗██╗ ██████╗██╗  ██╗███████╗███╗   ██╗', ' ██╔════╝██║  ██║██║██╔════╝██║ ██╔╝██╔════╝████╗  ██║', ' ██║     ███████║██║██║     █████╔╝ █████╗  ██╔██╗ ██║', ' ██║     ██╔══██║██║██║     ██╔═██╗ ██╔══╝  ██║╚██╗██║', ' ╚██████╗██║  ██║██║╚██████╗██║  ██╗███████╗██║ ╚████║', '  ╚═════╝╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝'].map(accent).join('\n')
      : accent('  C H I C K E N B O T S')
    this.output.write(`\n${title}\n\n ${cyan('◆ FIVE-BOT CONTROL CENTRE')}  ${dim('// OPERATIONS CONSOLE')}\n ${dim('─'.repeat(wide ? 58 : Math.max(12, Math.min((this.output.columns || 40) - 2, 40))))}\n ${dim('TARGET')}     ${config.host}:${config.port}\n ${dim('DASHBOARD')}  http://${config.dashboardHost}:${config.dashboardPort}\n ${dim('FLEET')}      05 independent controllers  ${dim('•')}  ${config.delay / 1000}s stagger\n ${dim('COMMANDS')}   type ${accent('help')} for controls  ${dim('•')}  ${accent('config')} to edit settings\n\n`)
  }
  log (line, level) {
    const colour = { info: '36', success: '1;92', warning: '33', error: '1;91', debug: '2' }[level] || '37'
    this.write(this.paint(line, colour))
  }
  help () {
    const heading = this.paint('COMMAND REFERENCE', '1;92')
    this.write(`\n ${heading}\n ${this.paint('─'.repeat(46), '2')}\n  status                 Fleet connection & auth state\n  server  |  ping        Target address / available latency\n  start [bot|all]        Start one bot or the entire fleet\n  stop [bot|all]         Safely disconnect\n  reconnect [bot|all]    Restart connections\n  chat <bot> <message>   Send a manual chat message\n  config                 Edit settings (restart to apply)\n  clear  |  help  |  exit\n`)
  }
  status (snapshot) {
    const rows = snapshot.bots.map((bot, index) => {
      const colour = bot.state === 'CONNECTED' ? '1;92' : ['ERROR', 'AUTHENTICATION_FAILED'].includes(bot.state) ? '91' : bot.state === 'RECONNECTING' ? '33' : '36'
      return `  ${String(index + 1).padStart(2, '0')}   ${bot.name.padEnd(8)}  ${this.paint(bot.state.padEnd(22), colour)} ${bot.auth}`
    })
    this.write(`\n ${this.paint('FLEET STATUS', '1;92')}  ${this.paint('// LIVE', '36')}\n ${this.paint('─'.repeat(53), '2')}\n  ID   BOT       CONNECTION             SERVER AUTH\n${rows.join('\n')}\n`)
  }
}
module.exports = Terminal
