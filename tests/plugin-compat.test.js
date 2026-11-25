'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { config, validateConfig } = require('../src/config');
const {
  resolveAuthProfile, classifyAuthText, buildAuthCommand, redactAuthCommand, validateAuthProfile
} = require('../src/bot/authProfiles');
const { detectServerSoftware, detectCapabilities } = require('../src/plugins/capabilities');
const { RealBot } = require('../src/bot/realBot');
const { shouldPauseAuthRetry } = require('../src/runtime');

function authBot({ profile = 'authme', maxAttempts = 2, reply = null, prompt = false, registerPassword = null, registration = false } = {}) {
  const commands = [];
  const real = new RealBot({
    name: '________',
    authProfile: profile,
    credentials: { password: 'secret', ...(registerPassword ? { registerPassword } : {}) },
    authEnabled: true,
    authRegistrationEnabled: registration,
    authDelayMs: 0,
    authTimeoutMs: 700,
    authMaxAttempts: maxAttempts
  });
  const fake = {
    entity: {},
    physicsEnabled: true,
    game: { serverBrand: 'Paper' },
    protocolVersion: 775,
    chat(line) {
      commands.push(line);
      if (reply) setImmediate(() => real._testChat(reply(line)));
    },
    clearControlStates() {},
    quit() {}
  };
  real.bot = fake;
  real.connected = true;
  real.spawned = true;
  real.onChat = (listener) => { real._testChat = listener; return () => {}; };
  real.authPromptSeen = prompt;
  if (prompt) real.authPrompt = 'Please login with /login <password>';
  return { real, commands, fake };
}

test('auth profiles are explicit and unknown profiles fail closed', () => {
  assert.equal(resolveAuthProfile('none').pluginAuth, false);
  const authme = resolveAuthProfile('authme');
  assert.equal(authme.plugin, 'AuthMe');
  assert.equal(authme.requireChallenge, true);
  assert.equal(authme.loginTemplate, '/login {password}');
  assert.throws(() => resolveAuthProfile('made-up-plugin'), /unknown authentication profile/);
  assert.throws(() => resolveAuthProfile('authme', { loginTemplate: '/login' }), /must contain \{password\}/);
  assert.equal(validateAuthProfile(resolveAuthProfile('authme')).ok, true);
  assert.equal(validateAuthProfile({ ...resolveAuthProfile('authme'), maxAttempts: 9 }).ok, false);
});

test('an explicit connection profile overrides the legacy MC_AUTH value', () => {
  const microsoft = new RealBot({ name: '________', authProfile: 'microsoft', auth: 'offline' });
  assert.equal(microsoft.connectionAuth, 'microsoft');
  assert.equal(microsoft.auth, 'microsoft');
  const none = new RealBot({ name: '________', authProfile: 'none', auth: 'offline' });
  assert.equal(none.auth, 'offline');
});

test('authentication text is classified without treating conversation as a prompt', () => {
  const authme = resolveAuthProfile('authme');
  assert.equal(classifyAuthText('Please login with /login <password>', authme).kind, 'prompt');
  assert.equal(classifyAuthText('Login successful.', authme).kind, 'success');
  assert.equal(classifyAuthText('You are already registered.', authme).kind, 'success');
  assert.equal(classifyAuthText('Wrong password. Try again.', authme).kind, 'failure');
  assert.equal(classifyAuthText('You are not registered.', authme).kind, 'not_registered');
  assert.equal(classifyAuthText('The garden looks nice today.', authme).kind, 'unknown');
});

test('auth command construction refuses empty passwords and redacts the command', () => {
  assert.equal(buildAuthCommand('/login {password}', 'secret'), '/login secret');
  assert.throws(() => buildAuthCommand('/login {password}', ''), /password is missing/);
  assert.equal(redactAuthCommand('/login secret', 'secret'), '/login [redacted]');
});

test('capability detection never guesses a plugin from an absent brand', () => {
  const unknown = detectServerSoftware(null);
  assert.equal(unknown.confidence, 'UNKNOWN');
  const paper = detectServerSoftware('Paper 26.1');
  assert.equal(paper.id, 'paper');
  assert.equal(paper.confidence, 'DETECTED');
  const caps = detectCapabilities({ brand: 'Paper', protocol: 775, version: '26.1', authProfile: resolveAuthProfile('authme'), authPromptSeen: true });
  assert.equal(caps.edition, 'java');
  assert.equal(caps.software.id, 'paper');
  assert.equal(caps.protocol.status, 'VALIDATED');
  assert.equal(caps.auth.confidence, 'DETECTED');
  assert.equal(caps.antiCheat.confidence, 'UNKNOWN');
  assert.equal(caps.bedrock.confidence, 'NOT_SUPPORTED');
});

test('config rejects an unknown profile, legacy boolean auth, and validates authme', () => {
  const base = JSON.parse(JSON.stringify(config));
  const badProfile = JSON.parse(JSON.stringify(base));
  badProfile.server.authProfile = 'not-a-profile';
  assert.ok(validateConfig(badProfile).errors.some((error) => /authProfile/.test(error)));

  const legacy = JSON.parse(JSON.stringify(base));
  legacy.server.authCommandsEnabled = true;
  assert.ok(validateConfig(legacy).errors.some((error) => /legacy boolean/.test(error)));

  const good = JSON.parse(JSON.stringify(base));
  good.server.authProfile = 'authme';
  good.server.authCommandsEnabled = false;
  good.server.loginCommand = '/login {password}';
  good.server.authRegistrationEnabled = false;
  const result = validateConfig(good);
  assert.equal(result.errors.length, 0, result.errors.join('\n'));
});

test('authme waits for a real challenge before sending a password', async () => {
  const { real, commands } = authBot({ prompt: false });
  real.authTimeoutMs = 80;
  const result = await real._handleLoginCommands();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTH_PROMPT_TIMEOUT');
  assert.deepEqual(commands, [], 'no password command may be sent without a challenge');
});

test('authme sends only once when the challenge is observed and confirms login', async () => {
  const { real, commands } = authBot({ prompt: true, reply: () => 'Login successful.' });
  const result = await real._handleLoginCommands();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(commands, ['/login secret']);
  assert.equal(real.authenticated, true);
});

test('auth attempts are bounded by the profile, not resent until timeout', async () => {
  const { real, commands } = authBot({ prompt: true, reply: null, maxAttempts: 2 });
  const result = await real._sendAuthCommand('/login secret', 'login');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTH_TIMEOUT');
  assert.equal(commands.length, 2);
  assert.equal(result.attempts, 2);
});

test('a challenge waiter is aborted promptly when the session closes', async () => {
  const { real } = authBot({ prompt: false });
  const waiting = real._waitForAuthChallenge(5000);
  real._abortAuth('socket closed');
  const result = await waiting;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTH_ABORTED');
  assert.equal(real.authChallengeWaiters.size, 0);
});

test('permanent auth failures pause retries while transient ones recover', () => {
  assert.equal(shouldPauseAuthRetry({ ok: false, code: 'AUTH_REJECTED', error: 'Wrong password.' }), true);
  assert.equal(shouldPauseAuthRetry({ ok: false, code: 'AUTH_NOT_REGISTERED', error: 'Not registered.' }), true);
  assert.equal(shouldPauseAuthRetry({ ok: false, code: 'AUTH_MISSING_CREDENTIAL', error: 'no credential' }), true);
  assert.equal(shouldPauseAuthRetry({ ok: false, code: 'AUTH_PROMPT_TIMEOUT', error: 'no challenge' }), true);
  assert.equal(shouldPauseAuthRetry({ ok: false, code: 'AUTH_TIMEOUT', error: 'timed out' }), false);
  assert.equal(shouldPauseAuthRetry({ ok: false, code: 'AUTH_FAILED', error: 'Wrong password.' }), true);
  assert.equal(shouldPauseAuthRetry({ ok: false, code: 'AUTH_FAILED', error: 'connection reset' }), false);
  assert.equal(shouldPauseAuthRetry({ ok: true }), false);
});

test('a not-registered reply does not auto-create an account unless registration is enabled', async () => {
  const { real, commands } = authBot({
    prompt: true, registerPassword: 'register-secret', registration: false,
    reply: () => 'You are not registered.'
  });
  const result = await real._handleLoginCommands();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTH_NOT_REGISTERED');
  assert.deepEqual(commands, ['/login secret']);
});

test('an echoed auth command never leaks the password into an error result', async () => {
  const { real } = authBot({ prompt: true, reply: (line) => `Unknown command: ${line}` });
  const result = await real._handleLoginCommands();
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.match(String(result.error), /\[redacted\]/);
});

test('manual auth stays pending and never sends a command', async () => {
  const real = new RealBot({ name: '________', authProfile: 'manual' });
  real.bot = { entity: {}, game: {}, chat() { throw new Error('must not send'); } };
  real.connected = true;
  real.spawned = true;
  const result = await real._handleLoginCommands();
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(real.authenticated, false);
  assert.equal(real.authRequiredManual, true);
});

test('per-bot credentials are redacted from log text', () => {
  const { redactString } = require('../src/util/redact');
  const previous = config.server.credentials;
  config.server.credentials = { '________': { password: 'topsecret123' } };
  try {
    const output = redactString('reply /login topsecret123 and password=topsecret123');
    assert.doesNotMatch(output, /topsecret123/);
    assert.match(output, /\[redacted\]/);
  } finally {
    config.server.credentials = previous;
  }
});
