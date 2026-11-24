'use strict';

const FORBIDDEN = /[;&|`$<>\\\n\r\t]|\.\.\//;
const NAME_PATTERN = /^[a-z][a-z0-9:_-]{0,31}$/;
const { redactString, redactValue } = require('../util/redact');

class CommandError extends Error {
  constructor(message, code = 'COMMAND_ERROR', details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Split a command line, honouring single and double quotes. */
function tokenize(line) {
  if (typeof line !== 'string') throw new CommandError('command must be a string');
  const raw = String(line).trim();
  if (!raw) throw new CommandError('empty command');
  if (raw.length > 600) throw new CommandError('command too long');
  if (FORBIDDEN.test(raw)) throw new CommandError('illegal characters in command (shell syntax is never accepted)');
  const tokens = [];
  let current = '';
  let quote = null;
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if ((char === '"' || char === "'") && current === '') {
      // Only a quote at the start of a token opens a quoted string. This keeps
      // JSON parameter objects (`--params {"block":"stone"}`) intact instead of
      // silently stripping their property quotes.
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += char;
    }
  }
  if (quote) throw new CommandError('unterminated quote');
  if (current) tokens.push(current);
  if (!tokens.length) throw new CommandError('empty command');
  if (tokens.length > 48) throw new CommandError('too many arguments');
  return tokens;
}

class CommandRegistry {
  constructor({ logger = null } = {}) {
    this.commands = new Map();
    this.aliases = new Map();
    this.logger = logger;
    this.history = [];
    this.seq = 0;
  }

  register(definition) {
    if (!definition || !definition.name) throw new Error('command requires a name');
    if (!NAME_PATTERN.test(definition.name)) throw new Error(`invalid command name: ${definition.name}`);
    if (this.commands.has(definition.name)) throw new Error(`duplicate command: ${definition.name}`);
    if (typeof definition.execute !== 'function') throw new Error(`command ${definition.name} requires execute()`);
    const command = {
      name: definition.name,
      aliases: definition.aliases || [],
      category: definition.category || 'general',
      summary: definition.summary || '',
      usage: definition.usage || definition.name,
      examples: definition.examples || [],
      dangerous: Boolean(definition.dangerous),
      requiresConfirmation: Boolean(definition.requiresConfirmation),
      minArgs: definition.minArgs === undefined ? 0 : definition.minArgs,
      maxArgs: definition.maxArgs === undefined ? 32 : definition.maxArgs,
      execute: definition.execute
    };
    // Validate every alias before mutating the registry. Previously a bad
    // alias left the command registered without its full alias set, so a
    // startup error could produce an inconsistent command surface.
    for (const alias of command.aliases) {
      if (!NAME_PATTERN.test(alias)) throw new Error(`invalid alias: ${alias}`);
      if (this.aliases.has(alias) || this.commands.has(alias)) throw new Error(`duplicate alias: ${alias}`);
    }
    this.commands.set(command.name, command);
    for (const alias of command.aliases) this.aliases.set(alias, command.name);
    return command;
  }

  get(name) {
    const key = String(name || '').toLowerCase();
    if (this.commands.has(key)) return this.commands.get(key);
    if (this.aliases.has(key)) return this.commands.get(this.aliases.get(key));
    return null;
  }

  list(category = null) {
    return [...this.commands.values()]
      .filter((c) => !category || c.category === category)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, aliases, category: cat, summary, usage, dangerous, requiresConfirmation }) => ({ name, aliases, category: cat, summary, usage, dangerous, requiresConfirmation }));
  }

  help(name = null) {
    if (name) {
      const command = this.get(name);
      if (!command) return { ok: false, error: `unknown command: ${name}`, commands: this.list() };
      return { ok: true, command: { name: command.name, usage: command.usage, summary: command.summary, examples: command.examples, dangerous: command.dangerous, requiresConfirmation: command.requiresConfirmation, args: command.minArgs } };
    }
    const categories = {};
    for (const command of this.list()) {
      categories[command.category] = categories[command.category] || [];
      categories[command.category].push(command);
    }
    return { ok: true, categories, count: this.commands.size };
  }

  /**
   * Execute a command line. `source` is one of terminal | cli | dashboard |
   * internal | chat. Dangerous commands are refused from chat; confirmation is
   * explicit and never inferred.
   */
  async execute(line, { source = 'internal', operator = 'console', confirmed = false } = {}) {
    const started = Date.now();
    let tokens;
    try {
      tokens = tokenize(line);
    } catch (err) {
      return this._record({ ok: false, error: err.message, code: err.code }, { line, source, operator, started });
    }
    const [name, ...args] = tokens;
    const command = this.get(name);
    if (!command) {
      return this._record({ ok: false, error: `unknown command: ${name}. Try 'help'`, code: 'UNKNOWN_COMMAND' }, { line, source, operator, started });
    }
    if (source === 'chat' && (command.dangerous || command.requiresConfirmation)) {
      return this._record({ ok: false, error: `refusing '${command.name}' from chat; use the dashboard or terminal`, code: 'CHAT_REFUSED' }, { line, source, operator, started });
    }
    if (args.length < command.minArgs) {
      return this._record({ ok: false, error: `missing arguments. usage: ${command.usage}`, code: 'ARGS' }, { line, source, operator, started });
    }
    if (args.length > command.maxArgs) {
      return this._record({ ok: false, error: `too many arguments. usage: ${command.usage}`, code: 'ARGS' }, { line, source, operator, started });
    }
    const explicitConfirm = confirmed || args.includes('confirm') || args.includes('--confirm');
    if (command.requiresConfirmation && !explicitConfirm) {
      return this._record({
        ok: false, error: `'${command.name}' is destructive and requires explicit confirmation (append 'confirm')`, code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true
      }, { line, source, operator, started });
    }
    try {
      const result = await command.execute(args.filter((a) => a !== 'confirm' && a !== '--confirm'), { source, operator, confirmed: explicitConfirm }, this);
      return this._record({ command: command.name, ...(result || { ok: true }) }, { line, source, operator, started });
    } catch (err) {
      const code = err instanceof CommandError ? err.code : 'EXECUTION_ERROR';
      if (this.logger) this.logger.error(`command '${line}' failed: ${err.message}`);
      return this._record({ ok: false, command: command.name, error: err.message, code, details: err.details || null }, { line, source, operator, started });
    }
  }

  _record(result, meta) {
    const entry = {
      id: `cmd-${++this.seq}`,
      at: Date.now(),
      // Command history is served to the dashboard: redact both the typed
      // line and the result so a future command that accepts a secret cannot
      // leak it through /api/commands.
      line: redactString(meta.line),
      source: meta.source,
      operator: meta.operator,
      durationMs: Date.now() - meta.started,
      ok: result.ok !== false,
      result: redactValue(result)
    };
    this.history.push(entry);
    if (this.history.length > 300) this.history.shift();
    return entry;
  }

  recent(limit = 20) { return this.history.slice(-limit); }
}

module.exports = { CommandRegistry, CommandError, tokenize, FORBIDDEN, NAME_PATTERN };
