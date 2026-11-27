'use strict';

const FORBIDDEN = /[;&|`$<>\\\n\r\t]|\.\.\//;
const NAME_PATTERN = /^[a-z][a-z0-9:_-]{0,31}$/;
const { redactString, redactValue } = require('../util/redact');

/**
 * Serialise one already-validated argument for the tokenizer. This is the only
 * place the frontend/API layer may turn structured input into command text:
 * quotes are only opened when a token actually needs them, and shell syntax is
 * rejected before it can reach a handler.
 */
function serializeArg(value) {
  if (value === null || value === undefined) throw new CommandError('command argument cannot be empty', 'ARGS');
  const text = String(value);
  if (!text.length) throw new CommandError('command argument cannot be empty', 'ARGS');
  if (FORBIDDEN.test(text)) throw new CommandError('illegal characters in command argument (shell syntax is never accepted)', 'ARGS');
  if (/\s/.test(text) || /^["']/.test(text)) {
    if (text.includes('"')) throw new CommandError('command argument cannot contain a double quote', 'ARGS');
    return `"${text}"`;
  }
  return text;
}

/**
 * Merge the authored metadata with the registered definition. The definition
 * stays the authority for whether a command exists and how many raw arguments
 * it accepts; the metadata adds the argument schema and semantics the operator
 * surfaces need. A mismatch is a startup error, never a silently wrong button.
 */
function normalizeMetadata(definition, metadata = {}) {
  const normalizeArgs = (list = []) => list.map((entry, index) => ({
    ...entry,
    // Positional grammar is the array order. Authoring a separate position was
    // how duplicated coordinates could slip in; the array is the contract.
    position: index,
    required: Boolean(entry.required)
  }));
  const args = normalizeArgs(metadata.args);
  const subcommands = (metadata.subcommands || []).map((entry) => (
    typeof entry === 'string' ? entry : { ...entry, args: normalizeArgs(entry.args) }
  ));
  const readOnly = metadata.readOnly === true;
  const mutates = readOnly ? false : metadata.mutates !== false;
  const confirmation = metadata.confirmation
    || (definition.requiresConfirmation ? 'always' : (metadata.confirmSubcommands && metadata.confirmSubcommands.length ? 'conditional' : 'never'));
  return {
    ...metadata,
    args,
    argumentSchema: args,
    requiredArgs: args.filter((entry) => entry.required).map((entry) => entry.name),
    optionalArgs: args.filter((entry) => !entry.required).map((entry) => entry.name),
    scope: metadata.scope || 'none',
    readOnly,
    mutates,
    cancellable: Boolean(metadata.cancellable),
    createsTasks: Boolean(metadata.createsTasks),
    confirmation,
    confirmSubcommands: metadata.confirmSubcommands || [],
    subcommands,
    // Command-level value groups (e.g. the woodcutting role enum) that are not
    // tied to a single positional argument. Pages read these instead of
    // keeping a second copy of a backend enum.
    values: { ...(metadata.values || {}) },
    targetSource: metadata.targetSource || null,
    page: metadata.page === undefined || metadata.page === '' ? null : metadata.page,
    palette: metadata.palette !== false,
    errorCodes: metadata.errorCodes || []
  };
}

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
      metadata: normalizeMetadata(definition, definition.metadata || {}),
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

  /**
   * Attach the authored schema table after every handler has registered.
   * Missing or orphaned entries are hard errors so `/api/commands` can never
   * advertise a command the CLI cannot run (or hide one it can).
   */
  annotate(table = {}) {
    const seen = new Set();
    for (const [name, metadata] of Object.entries(table)) {
      const command = this.commands.get(name);
      if (!command) throw new Error(`command metadata references unknown command: ${name}`);
      if (seen.has(name)) throw new Error(`duplicate command metadata: ${name}`);
      seen.add(name);
      command.metadata = normalizeMetadata(command, metadata);
    }
    const missing = [...this.commands.keys()].filter((name) => !seen.has(name));
    if (missing.length) throw new Error(`commands without metadata: ${missing.join(', ')}`);
    return this;
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
      .map(({ name, aliases, category: cat, summary, usage, examples, dangerous, requiresConfirmation, minArgs, maxArgs, metadata }) => ({
        name, aliases, category: cat, summary, usage, examples, dangerous, requiresConfirmation, minArgs, maxArgs,
        args: metadata.args,
        argumentSchema: metadata.argumentSchema,
        requiredArgs: metadata.requiredArgs,
        optionalArgs: metadata.optionalArgs,
        variants: metadata.variants || [],
        subcommands: metadata.subcommands,
        scope: metadata.scope,
        readOnly: metadata.readOnly,
        mutates: metadata.mutates,
        cancellable: metadata.cancellable,
        createsTasks: metadata.createsTasks,
        confirmation: metadata.confirmation,
        confirmSubcommands: metadata.confirmSubcommands,
        values: metadata.values || {},
        targetSource: metadata.targetSource,
        page: metadata.page,
        palette: metadata.palette,
        errorCodes: metadata.errorCodes,
        metadata
      }));
  }

  help(name = null) {
    if (name) {
      const label = String(name).toLowerCase();
      const command = this.get(label);
      if (command) {
        return {
          ok: true,
          command: {
            name: command.name, category: command.category, aliases: command.aliases,
            usage: command.usage, summary: command.summary, examples: command.examples,
            dangerous: command.dangerous, requiresConfirmation: command.requiresConfirmation,
            minArgs: command.minArgs, maxArgs: command.maxArgs,
            args: command.metadata.args, argumentSchema: command.metadata.argumentSchema,
            variants: command.metadata.variants || [], subcommands: command.metadata.subcommands,
            scope: command.metadata.scope, confirmation: command.metadata.confirmation
          }
        };
      }
      // `help builder` is more useful as the category list than as an error.
      const category = this.list().filter((entry) => entry.category === label);
      if (category.length) return { ok: true, category: label, count: category.length, commands: category };
      return { ok: false, error: `unknown command or category: ${name}`, commands: this.list() };
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
    // `--help` is a universal, side-effect-free probe. It makes every command
    // discoverable without running it and gives scripts a safe audit path.
    if (args.includes('--help') || args.includes('-h')) {
      return this._record({
        ok: true, command: command.name,
        help: {
          name: command.name, category: command.category, aliases: command.aliases,
          usage: command.usage, summary: command.summary, examples: command.examples,
          dangerous: command.dangerous, requiresConfirmation: command.requiresConfirmation,
          minArgs: command.minArgs, maxArgs: command.maxArgs,
          args: command.metadata.args, argumentSchema: command.metadata.argumentSchema,
          variants: command.metadata.variants || [], subcommands: command.metadata.subcommands,
          scope: command.metadata.scope, confirmation: command.metadata.confirmation
        }
      }, { line, source, operator, started });
    }
    if (args.length < command.minArgs) {
      return this._record({ ok: false, error: `missing arguments. usage: ${command.usage}`, code: 'ARGS' }, { line, source, operator, started });
    }
    if (args.length > command.maxArgs) {
      return this._record({ ok: false, error: `too many arguments. usage: ${command.usage}`, code: 'ARGS' }, { line, source, operator, started });
    }
    const explicitConfirm = confirmed || args.includes('confirm') || args.includes('--confirm');
    if (this.requiresConfirmationFor(command, args) && !explicitConfirm) {
      return this._record({
        ok: false, command: command.name,
        error: `'${command.name}${args.length ? ` ${args[0]}` : ''}' is destructive and requires explicit confirmation (append 'confirm')`,
        code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true
      }, { line, source, operator, started });
    }
    try {
      const result = await command.execute(args.filter((a) => a !== 'confirm' && a !== '--confirm'), { source, operator, confirmed: explicitConfirm, line }, this);
      return this._record({ command: command.name, ...(result || { ok: true }) }, { line, source, operator, started });
    } catch (err) {
      const code = err instanceof CommandError ? err.code : 'EXECUTION_ERROR';
      if (this.logger) this.logger.error(`command '${line}' failed: ${err.message}`);
      return this._record({ ok: false, command: command.name, error: err.message, code, details: err.details || null }, { line, source, operator, started });
    }
  }

  /** True when this exact invocation must be confirmed before it can run. */
  requiresConfirmationFor(commandOrName, args = []) {
    const command = typeof commandOrName === 'string' ? this.get(commandOrName) : commandOrName;
    if (!command) return false;
    if (command.requiresConfirmation) return true;
    const metadata = command.metadata || {};
    // Metadata confirmation is the UI's proactive prompt. It is only enforced
    // by the registry when a handler already required it (or a command opts in
    // explicitly), so adding operator metadata never changes CLI behaviour.
    if (metadata.enforceConfirmation !== true) return false;
    if (metadata.confirmation === 'always') return true;
    const sub = String(args[0] || '').toLowerCase();
    return Boolean(sub && (metadata.confirmSubcommands || []).includes(sub));
  }

  /**
   * Validate a structured invocation without executing it. This is deliberately
   * limited to contract checks (known command, known-ish argument count);
   * semantic validation remains inside the handler so there is exactly one
   * authority for what the world accepts.
   */
  validate(name, args = []) {
    const command = this.get(name);
    if (!command) return { ok: false, code: 'UNKNOWN_COMMAND', error: `unknown command: ${name}` };
    if (!Array.isArray(args)) return { ok: false, code: 'ARGS', error: 'command args must be an array' };
    const list = args;
    if (list.length < command.minArgs) return { ok: false, code: 'ARGS', error: `missing arguments. usage: ${command.usage}` };
    if (list.length > command.maxArgs) return { ok: false, code: 'ARGS', error: `too many arguments. usage: ${command.usage}` };
    return { ok: true, command: command.name, requiresConfirmation: this.requiresConfirmationFor(command, list) };
  }

  /** Build a tokenizer-safe line from structured input. */
  serialize(name, args = []) {
    const command = this.get(name);
    if (!command) throw new CommandError(`unknown command: ${name}`, 'UNKNOWN_COMMAND');
    const list = Array.isArray(args) ? args : [];
    if (!list.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry))) {
      throw new CommandError('command arguments must be strings, numbers or booleans', 'ARGS');
    }
    return [command.name, ...list.map(serializeArg)].join(' ');
  }

  /** Strict structured entry point: validate, serialise and execute once. */
  async executeStructured({ name, args = [], source = 'dashboard', operator = 'dashboard', confirmed = false } = {}) {
    const started = Date.now();
    const command = this.get(name);
    if (!command) {
      return this._record({ ok: false, error: `unknown command: ${name}`, code: 'UNKNOWN_COMMAND' }, { line: String(name || ''), source, operator, started });
    }
    if (!Array.isArray(args)) {
      return this._record({ ok: false, command: command.name, error: 'command args must be an array', code: 'ARGS' }, { line: command.name, source, operator, started });
    }
    const check = this.validate(command.name, args);
    if (!check.ok) {
      return this._record({ ok: false, command: command.name, error: check.error, code: check.code }, { line: command.name, source, operator, started });
    }
    let line;
    try {
      line = `${command.name}${args.length ? ` ${args.map(serializeArg).join(' ')}` : ''}`;
    } catch (err) {
      return this._record({ ok: false, command: command.name, error: err.message, code: err.code || 'ARGS' }, { line: command.name, source, operator, started });
    }
    return this.execute(line, { source, operator, confirmed });
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

module.exports = { CommandRegistry, CommandError, tokenize, serializeArg, normalizeMetadata, FORBIDDEN, NAME_PATTERN };
