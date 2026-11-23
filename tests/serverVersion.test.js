'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveServerVersion, versionFromStatus, configuredVersion } = require('../src/bot/serverVersion');

const fakeData = {
  versionsByMinecraftVersion: { pc: { '1.21.4': { minecraftVersion: '1.21.4', version: 769 } } },
  postNettyVersionsByProtocolVersion: { pc: { 769: [{ minecraftVersion: '1.21.4', version: 769 }] } }
};

test('a sleeping/starting server reports a retryable not-ready error instead of crashing', async () => {
  const result = await resolveServerVersion({
    version: 'auto',
    ping: async () => ({ version: { name: 'Aternos', protocol: -1 } }),
    minecraftData: fakeData,
    timeoutMs: 100
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SERVER_NOT_READY');
  assert.equal(result.retryable, true);
  assert.match(result.error, /offline|starting/i);
  assert.doesNotThrow(() => versionFromStatus(undefined, fakeData));
});

test('a valid status ping resolves to an explicit supported version', async () => {
  const result = await resolveServerVersion({
    version: 'auto',
    ping: async () => ({ version: { name: 'Paper 1.21.4', protocol: 769 } }),
    minecraftData: fakeData,
    timeoutMs: 100
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.21.4');
  assert.equal(result.protocol, 769);
});

test('an unknown protocol is reported as unsupported, not dereferenced', async () => {
  const result = await resolveServerVersion({
    version: 'auto',
    ping: async () => ({ version: { name: 'Future', protocol: 99999 } }),
    minecraftData: fakeData,
    timeoutMs: 100
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_PROTOCOL');
  assert.match(result.error, /npm update/);
});

test('an explicit version is validated without pinging and a bad value is reported', () => {
  assert.equal(configuredVersion('1.21.4', fakeData).ok, true);
  const bad = configuredVersion('not-a-version', fakeData);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'UNSUPPORTED_VERSION');
  const empty = configuredVersion('', fakeData);
  assert.equal(empty.code, 'INVALID_VERSION');
});

test('a probe timeout returns a retryable unreachable result', async () => {
  const result = await resolveServerVersion({
    version: 'auto',
    ping: () => new Promise(() => {}),
    minecraftData: fakeData,
    timeoutMs: 30
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SERVER_UNREACHABLE');
  assert.equal(result.retryable, true);
  assert.match(result.error, /timed out/i);
});

test('a ping failure is wrapped with its cause', async () => {
  const result = await resolveServerVersion({
    version: 'auto',
    ping: async () => { throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); },
    minecraftData: fakeData,
    timeoutMs: 100
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SERVER_UNREACHABLE');
  assert.equal(result.cause, 'ECONNRESET');
});

test('runtime preflight applies the resolved version to all five bots before connecting', async () => {
  const { TeamRuntime } = require('../src/runtime');
  const { BOT_NAMES } = require('../src/config');
  const runtime = new TeamRuntime({
    simulate: false, connect: false, dashboard: false,
    resolveVersion: async () => ({ ok: true, version: '1.21.4', protocol: 769, source: 'configured' })
  });
  await runtime.init();
  try {
    const ok = await runtime._ensureServerVersion();
    assert.equal(ok, true);
    assert.equal(runtime.serverVersion, '1.21.4');
    assert.equal(runtime.bots.size, 5);
    for (const name of BOT_NAMES) assert.equal(runtime.bots.get(name).version, '1.21.4');
  } finally {
    await runtime.shutdown('test');
  }
});

test('a status name newer than the answered protocol is ignored in favour of a supported protocol version', async () => {
  const result = await resolveServerVersion({
    version: 'auto',
    ping: async () => ({ version: { name: '26.3', protocol: 775 } }),
    timeoutMs: 100
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.version, '26.1');
  assert.equal(result.protocol, 775);
  assert.equal(result.source, 'protocol');
});

test('an explicit MC_VERSION must be supported by minecraft-protocol, not just minecraft-data', () => {
  const ok = configuredVersion('26.1');
  assert.equal(ok.ok, true);
  assert.equal(ok.protocol, 775);
  const bad = configuredVersion('26.3');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'UNSUPPORTED_VERSION');
});
