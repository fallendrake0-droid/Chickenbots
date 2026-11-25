'use strict';

/**
 * Explicit server-authentication profiles.
 *
 * The default is `none`: a spawned session is accepted as-is and no chat
 * command is ever sent. Plugin profiles are opt-in. They are challenge-driven:
 * the login command is only sent after the server prints a matching prompt,
 * unless the operator explicitly marks a profile as proactive.
 *
 * This module is pure. It never logs, never stores credentials and never reads
 * the environment. RealBot supplies the credentials from the ignored credential
 * file; tests can call these helpers directly.
 */

const CONFIDENCE = Object.freeze({
  CONFIGURED: 'CONFIGURED',
  DETECTED: 'DETECTED',
  INFERRED: 'INFERRED',
  UNKNOWN: 'UNKNOWN',
  NOT_SUPPORTED: 'NOT_SUPPORTED'
});

const PROMPT_RE = /(?:please\s+(?:log\s?in|register)|you\s+(?:must|need\s+to)\s+(?:log\s?in|register|authenticate)|not\s+(?:logged\s+in|authenticated)|login\s+required|register\s+required|authenticate\s+to\s+play|use\s+\/login|use\s+\/register)/i;
const LOGIN_SUCCESS_RE = /successfully logged in|you are now logged in|now logged in|already logged in|welcome back|logged in successfully|login successful|successfully authenticated|authentication successful|you (?:have been|are) (?:logged in|authenticated)/i;
const REGISTER_SUCCESS_RE = /successfully registered|registration (?:successful|complete)|you are now registered|already registered|now logged in|successfully logged in|already logged in|login successful|successfully authenticated|authentication successful|you (?:have been|are) (?:logged in|authenticated)/i;
const FAILURE_RE = /wrong password|incorrect password|invalid password|password (?:is )?(?:wrong|incorrect)|too many (?:attempts|tries)|locked out|account locked|kicked|unknown command|unknown or incomplete command|usage:\s*\/(?:login|register)|authentication failed|login failed|registration (?:failed|disabled)/i;
const NOT_REGISTERED_RE = /not registered|please register|register first|no account/i;
const ALREADY_REGISTERED_RE = /already registered/i;

const PROFILE_DEFINITIONS = Object.freeze({
  none: {
    id: 'none',
    label: 'No plugin authentication',
    plugin: null,
    pluginAuth: false,
    requireChallenge: false,
    proactive: false,
    registrationEnabled: false,
    maxAttempts: 0,
    retryDelayMs: 0,
    loginTemplate: '',
    registerTemplate: '',
    loginSuccessRe: LOGIN_SUCCESS_RE,
    registerSuccessRe: REGISTER_SUCCESS_RE,
    failureRe: FAILURE_RE,
    promptRe: PROMPT_RE
  },
  offline: {
    id: 'offline',
    label: 'Offline-mode connection (no plugin auth)',
    connectionAuth: 'offline',
    plugin: null,
    pluginAuth: false,
    requireChallenge: false,
    proactive: false,
    registrationEnabled: false,
    maxAttempts: 0,
    retryDelayMs: 0,
    loginTemplate: '',
    registerTemplate: '',
    loginSuccessRe: LOGIN_SUCCESS_RE,
    registerSuccessRe: REGISTER_SUCCESS_RE,
    failureRe: FAILURE_RE,
    promptRe: PROMPT_RE
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft account connection',
    connectionAuth: 'microsoft',
    plugin: null,
    pluginAuth: false,
    requireChallenge: false,
    proactive: false,
    registrationEnabled: false,
    maxAttempts: 0,
    retryDelayMs: 0,
    loginTemplate: '',
    registerTemplate: '',
    loginSuccessRe: LOGIN_SUCCESS_RE,
    registerSuccessRe: REGISTER_SUCCESS_RE,
    failureRe: FAILURE_RE,
    promptRe: PROMPT_RE
  },
  manual: {
    id: 'manual',
    label: 'Manual operator authentication',
    plugin: null,
    pluginAuth: false,
    requireChallenge: true,
    proactive: false,
    registrationEnabled: false,
    maxAttempts: 0,
    retryDelayMs: 0,
    loginTemplate: '',
    registerTemplate: '',
    loginSuccessRe: LOGIN_SUCCESS_RE,
    registerSuccessRe: REGISTER_SUCCESS_RE,
    failureRe: FAILURE_RE,
    promptRe: PROMPT_RE
  },
  authme: {
    id: 'authme',
    label: 'AuthMe',
    plugin: 'AuthMe',
    pluginAuth: true,
    requireChallenge: true,
    proactive: false,
    registrationEnabled: false,
    maxAttempts: 2,
    retryDelayMs: 1500,
    loginTemplate: '/login {password}',
    registerTemplate: '/register {password}',
    loginSuccessRe: LOGIN_SUCCESS_RE,
    registerSuccessRe: REGISTER_SUCCESS_RE,
    failureRe: FAILURE_RE,
    promptRe: PROMPT_RE
  },
  simpleauth: {
    id: 'simpleauth',
    label: 'SimpleAuth',
    plugin: 'SimpleAuth',
    pluginAuth: true,
    requireChallenge: true,
    proactive: false,
    registrationEnabled: false,
    maxAttempts: 2,
    retryDelayMs: 1500,
    loginTemplate: '/login {password}',
    registerTemplate: '/register {password}',
    loginSuccessRe: LOGIN_SUCCESS_RE,
    registerSuccessRe: REGISTER_SUCCESS_RE,
    failureRe: FAILURE_RE,
    promptRe: PROMPT_RE
  },
  generic: {
    id: 'generic',
    label: 'Generic chat authentication',
    plugin: 'generic-chat-auth',
    pluginAuth: true,
    requireChallenge: false,
    proactive: true,
    registrationEnabled: false,
    maxAttempts: 3,
    retryDelayMs: 1500,
    loginTemplate: '/login {password}',
    registerTemplate: '/register {password} {password}',
    loginSuccessRe: LOGIN_SUCCESS_RE,
    registerSuccessRe: REGISTER_SUCCESS_RE,
    failureRe: FAILURE_RE,
    promptRe: PROMPT_RE
  }
});

const PROFILE_IDS = Object.freeze(Object.keys(PROFILE_DEFINITIONS));

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a7./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveAuthProfile(id = 'none', overrides = {}) {
  const key = String(id || 'none').toLowerCase();
  const base = PROFILE_DEFINITIONS[key];
  if (!base) throw new Error(`unknown authentication profile: ${id}`);
  const merged = { ...base, ...(overrides || {}) };
  merged.id = key;
  merged.profile = key;
  merged.maxAttempts = Number.isInteger(merged.maxAttempts) ? Math.max(1, merged.maxAttempts) : base.maxAttempts;
  merged.retryDelayMs = Number.isFinite(merged.retryDelayMs) ? Math.max(250, merged.retryDelayMs) : base.retryDelayMs;
  if (merged.loginTemplate && !/\{password\}/.test(merged.loginTemplate)) {
    throw new Error(`authentication profile ${key} login template must contain {password}`);
  }
  if (merged.registerTemplate && !/\{password\}/.test(merged.registerTemplate)) {
    throw new Error(`authentication profile ${key} register template must contain {password}`);
  }
  if (merged.pluginAuth && !merged.loginTemplate) {
    throw new Error(`authentication profile ${key} requires a login template`);
  }
  return merged;
}

function classifyAuthText(text, profile = PROFILE_DEFINITIONS.none) {
  const clean = normalizeText(text);
  if (!clean) return { kind: 'empty', text: '' };
  const prompt = profile.promptRe && profile.promptRe.test(clean);
  const failure = profile.failureRe && profile.failureRe.test(clean);
  const registered = ALREADY_REGISTERED_RE.test(clean);
  const notRegistered = NOT_REGISTERED_RE.test(clean) && !registered;
  const success = (profile.loginSuccessRe && profile.loginSuccessRe.test(clean))
    || (profile.registerSuccessRe && profile.registerSuccessRe.test(clean));
  return {
    kind: failure ? 'failure' : notRegistered ? 'not_registered' : success || registered ? 'success' : prompt ? 'prompt' : 'unknown',
    prompt,
    success: Boolean(success || registered),
    failure: Boolean(failure),
    notRegistered,
    alreadyRegistered: registered,
    text: clean
  };
}

function buildAuthCommand(template, password) {
  const source = String(template || '');
  if (!source) throw new Error('authentication command template is empty');
  if (!/\{password\}/.test(source)) throw new Error('authentication command template must contain {password}');
  if (typeof password !== 'string' || password.length === 0) throw new Error('authentication password is missing');
  return source.replace(/\{password\}/g, password);
}

function redactAuthCommand(command, password) {
  let text = String(command || '');
  text = text.replace(/(\/\s*(?:login|register)\s+)([^\r\n]*)/gi, '$1[redacted]');
  if (password) text = text.split(String(password)).join('[redacted]');
  return text;
}

function validateAuthProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['auth profile must be an object'] };
  if (!PROFILE_IDS.includes(profile.id)) errors.push(`unknown profile id: ${profile.id}`);
  if (profile.pluginAuth) {
    if (!profile.loginTemplate) errors.push('plugin profile requires loginTemplate');
    if (!profile.loginSuccessRe) errors.push('plugin profile requires loginSuccessRe');
    if (!profile.failureRe) errors.push('plugin profile requires failureRe');
  }
  if (profile.registrationEnabled && !profile.registerTemplate) errors.push('registrationEnabled requires registerTemplate');
  if (!(profile.maxAttempts >= 1)) errors.push('maxAttempts must be at least 1');
  if (profile.pluginAuth && profile.maxAttempts > 5) errors.push('maxAttempts above 5 risks a server lockout');
  return { ok: errors.length === 0, errors };
}

module.exports = {
  CONFIDENCE,
  PROFILE_IDS,
  PROFILE_DEFINITIONS,
  PROMPT_RE,
  LOGIN_SUCCESS_RE,
  REGISTER_SUCCESS_RE,
  FAILURE_RE,
  normalizeText,
  resolveAuthProfile,
  classifyAuthText,
  buildAuthCommand,
  redactAuthCommand,
  validateAuthProfile
};
