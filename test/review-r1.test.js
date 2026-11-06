// -----------------------------------------------------------------------------
// The points of reviews r1 to r3, each with its test: 401/403 of a secondary
// route is not a refused token (I1); Scan and Test after a restart keep the
// pace (I2); the guards whose mutants survived (I3); the minor points; a cover
// close not reached is never re-closed over a hand opening a read showed; the
// list read by Test is the read of the session (r3 I5).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { retryAfterOf } from '../src/gateway.js';
import { buildModel, functionsOf, scenesOf } from '../src/model.js';
import { tokenMark } from '../src/store.js';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { certs, selfSigned } from './kit/certs.mjs';
import {
  OTHER_TOKEN,
  TOKEN,
  fakeGateway,
  fixtureFunctions,
  fixtureScenes,
} from './helpers/fakeGateway.js';
import { feature, pause, setup, waitFor, within } from './helpers/setup.js';

const LIGHT = 'idlight1-001';
const err = (ack) => ack.error ?? '';

// --- I1 -------------------------------------------------------------------------

test('I1: 403 on the scene list is "not read": values go on, never a refused token, stops leave', async (t) => {
  const s = await setup(t, { config: { live_updates: false } });
  s.gw.replyFor = (r) => (r.path === '/scenes/' ? { status: 403, body: {} } : undefined);
  await s.advance(300_000);
  await waitFor(() => s.gw.count('GET /scenes/') >= 2, 'the scene read');
  await pause(30);
  assert.equal(s.app.blocked, false);
  assert.equal(s.store.data.refused ?? null, null);
  assert.equal(s.app.online, true);
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  const ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, err(ack));
  // Spaced (doubling) from then on, not at every read.
  const reads = s.gw.count('GET /functions/');
  const scenes = s.gw.count('GET /scenes/');
  for (let i = 0; i < 6; i += 1) {
    await s.advance(60_000);
    await pause(40);
  }
  assert.ok(s.gw.count('GET /functions/') >= reads + 5);
  assert.ok(s.gw.count('GET /scenes/') - scenes < s.gw.count('GET /functions/') - reads, 'spaced');
  assert.equal(s.app.blocked, false);
});

test('I1: 401 on the socket opening is a lost socket, not a refused token', async (t) => {
  const s = await setup(t, { gateway: { wsToken: OTHER_TOKEN } });
  await waitFor(() => s.app.liveState === 'down', 'the socket lost');
  assert.equal(s.app.blocked, false);
  assert.equal(s.app.online, true);
  assert.match(s.message(), /live updates lost/);
  // Tried again later, still not a refusal; the reads go on.
  await s.advance(20_000);
  await pause(50);
  assert.equal(s.app.blocked, false);
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  const ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, err(ack));
});

test('I1: 403 on the serial number, a read back or a stop: never a refused token', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) =>
    r.path === '/config/parameter/system_serial' ? { status: 403, body: {} } : undefined;
  s.app.stop();
  await within(s.app.start(s.raw), 'restart');
  await s.advance(61_000);
  await s.online();
  assert.equal(s.app.blocked, false);
  assert.equal(s.app.identity.unreadable, true);
  // A stop refused 403 on its route: kept, not counted, not a refused token; sent once allowed.
  let deny = true;
  s.gw.replyFor = (r) => (deny && r.method === 'PATCH' ? { status: 403, body: {} } : undefined);
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  const pending = s.fire('idlight1', 'on', 0);
  await pause(50);
  await s.advance(3500);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.equal(s.app.blocked, false);
  assert.equal([...s.app.guards.values()][0].answered, 0);
  deny = false;
  for (let i = 0; i < 20 && s.gw.value(LIGHT, 'switch') !== '0'; i += 1) {
    await s.advance(1000);
    await pause(30);
  }
  assert.equal(s.gw.value(LIGHT, 'switch'), '0');
  // A read back refused 403: not a refusal either.
  s.gw.replyFor = (r) =>
    r.method === 'GET' && r.path.endsWith(LIGHT) ? { status: 403, body: {} } : undefined;
  s.app.config = { ...s.app.config };
  s.app.identity = { ...s.app.identity, verified: true };
  const on = await s.fire('idlight1', 'on', 1);
  assert.equal(on.success, false, 'not confirmed');
  assert.equal(s.app.blocked, false);
});

test('I1: a command refused 401 is refused, not a refused token; the function list decides', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) => (r.method === 'PATCH' ? { status: 401, body: {} } : undefined);
  const ack = await s.fire('iddim1', 'brightness', 40);
  assert.match(err(ack), /401\/403 on this route|401\/403 sur cette route/);
  assert.equal(s.app.blocked, false);
  s.gw.replyFor = (r) => (r.path === '/functions/' ? { status: 401, body: {} } : undefined);
  await s.advance(300_000);
  await waitFor(() => s.app.blocked, 'refused by the function list');
});

// --- I2 -------------------------------------------------------------------------

test('I2: after a restart, Scan and Test do not read before the interval after the last read (/data)', async (t) => {
  const s = await setup(t);
  assert.ok(s.store.data.lastReadAt);
  const reads = s.gw.count('GET /functions/');
  // A new process: nothing in memory but /data.
  s.app.stop();
  s.app.memoryState = 'unloaded';
  s.app.lastReadMono = -Infinity;
  s.app.lastTest = undefined;
  await within(s.app.start(s.raw), 'restart');
  await s.advance(5000);
  await within(s.fake.scanRequest(), 'scan');
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Not read again before the interval/);
  await pause(50);
  assert.equal(s.gw.count('GET /functions/'), reads, 'no read on Scan nor Test');
});

// --- I3 -------------------------------------------------------------------------

test('I3: the second click trusts only the certificate the first click showed', async (t) => {
  const s = await setup(t);
  const port = s.gw.port;
  await s.gw.close();
  let other = await fakeGateway({ port, cert: certs.impostor });
  let result = await within(s.app.trustCertificate(), 'first click');
  assert.match(result.en, /Click again/);
  await other.close();
  const third = selfSigned('third');
  other = await fakeGateway({ port, cert: third });
  t.after(() => other.close());
  result = await within(s.app.trustCertificate(), 'second click, another certificate');
  assert.match(result.en, /Click again/, 'shown again, not trusted');
  assert.equal(s.store.data.pins[other.address], certs.device.fingerprint256);
  result = await within(s.app.trustCertificate(), 'third click');
  assert.match(result.en, /New certificate trusted/);
  assert.equal(s.store.data.pins[other.address], third.fingerprint256);
});

test('I3: a fingerprint typed in the configuration is never replaced by a click', async (t) => {
  const s = await setup(t, { config: { certificate_fingerprint: certs.device.fingerprint256 } });
  const port = s.gw.port;
  await s.gw.close();
  const other = await fakeGateway({ port, cert: certs.impostor });
  t.after(() => other.close());
  for (let i = 0; i < 2; i += 1) {
    const result = await within(s.app.trustCertificate(), 'click');
    assert.match(result.en, /fingerprint typed in the configuration is the pin/);
  }
  assert.equal(s.store.data.pins[other.address], certs.device.fingerprint256);
});

test('I3: another gateway at the address: no state of it reaches the devices, no command of it is known', async (t) => {
  const s = await setup(t);
  await s.flush();
  s.gw.serial = 'JH9999';
  s.app.stop();
  await within(s.app.start(s.raw), 'restart');
  await s.advance(61_000);
  await s.online();
  assert.equal(s.app.identity.mismatch, 'snJH9999');
  assert.equal(s.app.model.writers.size, 0);
  const before = s.lastState('iddim1', 'brightness');
  s.gw.setValue('iddim1-002', 'brightness', 99, { push: false });
  await s.advance(300_000);
  await waitFor(() => s.gw.count('GET /functions/') >= 3, 'a read');
  await s.flush();
  assert.equal(s.lastState('iddim1', 'brightness'), before);
});

test('I3: a stop refused 4 times by the gateway is kept and shown, never sent a 5th time', async (t) => {
  const s = await setup(t);
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  s.gw.replyFor = (r) =>
    r.method === 'PATCH' ? { status: 423, body: { error: 'Device is locked' } } : undefined;
  const ack = s.fire('idlight1', 'on', 0);
  await pause(50);
  await s.advance(3500);
  await ack;
  for (let i = 0; i < 10; i += 1) {
    await s.advance(5000);
    await pause(30);
  }
  assert.equal(s.gw.sets(LIGHT).length, 4);
  assert.equal([...s.app.guards.values()][0].stuck, true);
  await s.app.showStatus();
  assert.match(s.message(), /Device is locked/);
});

test('I3: the Test button tests once per 10 s', async (t) => {
  const s = await setup(t);
  await s.advance(61_000);
  const first = await within(s.app.testConnection(), 'test');
  assert.match(first.en, /Connection OK/);
  const count = s.gw.requests.length;
  const second = await within(s.app.testConnection(), 'test');
  assert.deepEqual(second, first);
  assert.equal(s.gw.requests.length, count, 'no request');
});

test('I3: a cover move is never written to /data', async (t) => {
  const s = await setup(t);
  s.gw.drop = (r) => r.method === 'PATCH';
  const ack = s.fire('idblind1', 'state', -1);
  await pause(50);
  await s.advance(3500);
  await ack;
  await s.fire('idlight1', 'on', 0).catch(() => {});
  await pause(50);
  await s.advance(3500);
  await waitFor(() => (s.store.data.guards ?? []).length === 1, 'the switch-off kept');
  assert.deepEqual(
    s.store.data.guards.map((g) => g.key),
    ['switch'],
  );
  assert.equal(s.app.guards.size, 2, 'the close is still worked on in memory');
});

// --- Cover close not reached: never re-closed over a hand opening -------------------

test('a close that did not reach the gateway: dropped when read opened twice in a row, never re-closed', async (t) => {
  const s = await setup(t);
  let down = true;
  s.gw.drop = (r) => down && r.method === 'PATCH';
  const ack = s.fire('idblind1', 'state', -1);
  // The first send and its two quick retries (~250 ms) fail.
  for (let i = 0; i < 10; i += 1) {
    await s.advance(100);
    await pause(20);
  }
  await s.advance(3500);
  assert.equal((await ack).success, false);
  assert.equal([...s.app.guards.values()][0].needRead, true);
  // The gateway unreachable for us; the cover opened by hand meanwhile (level 30 -> 0).
  s.gw.setValue('idblind1-001', 'level', 0, { push: false });
  down = false;
  for (let i = 0; i < 6; i += 1) {
    await s.advance(5000);
    await pause(40);
  }
  await waitFor(() => s.app.guards.size === 0, 'the close dropped');
  assert.equal(s.gw.value('idblind1-001', 'level'), '0', 'never re-closed');
  assert.ok(s.gw.sets('idblind1-001').every((r) => r.json.data[0].key === 'level'));
  assert.equal(s.gw.sets('idblind1-001').filter((r) => !s.gw.requests.includes(r)).length, 0);
});

test('a close that did not reach the gateway, cover untouched: sent again once the gateway answers', async (t) => {
  const s = await setup(t);
  let down = true;
  s.gw.drop = (r) => down && r.method === 'PATCH';
  const ack = s.fire('idblind1', 'state', -1);
  await pause(50);
  await s.advance(3500);
  await ack;
  down = false;
  for (let i = 0; i < 10 && s.gw.value('idblind1-001', 'level') !== '100'; i += 1) {
    await s.advance(5000);
    await pause(40);
  }
  assert.equal(s.gw.value('idblind1-001', 'level'), '100');
});

test('a close read once opened, then as before: sent (two reads in a row are needed)', async (t) => {
  const s = await setup(t);
  let down = true;
  s.gw.drop = (r) => down && r.method === 'PATCH';
  const ack = s.fire('idblind1', 'state', -1);
  await pause(50);
  await s.advance(3500);
  await ack;
  const guard = [...s.app.guards.values()][0];
  s.gw.setValue('idblind1-001', 'level', 10, { push: false });
  await s.advance(5000);
  await waitFor(() => guard.changed === 1, 'one read opened');
  s.gw.setValue('idblind1-001', 'level', 30, { push: false });
  down = false;
  for (let i = 0; i < 10 && s.gw.value('idblind1-001', 'level') !== '100'; i += 1) {
    await s.advance(5000);
    await pause(40);
  }
  assert.equal(s.gw.value('idblind1-001', 'level'), '100');
});

// --- Minor points -------------------------------------------------------------------

test('M1: Test never says "token accepted" without an authenticated answer', async (t) => {
  const s = await setup(t);
  s.app.refuseToken();
  s.gw.replyFor = (r) =>
    r.path === '/config/parameter/system_serial' || r.path === '/functions/'
      ? { status: 503, body: {} }
      : undefined;
  await s.advance(61_000);
  const result = await within(s.app.testConnection(), 'test');
  assert.doesNotMatch(result.en, /Connection OK|accepted/);
  assert.equal(s.app.blocked, true, 'the refusal stays');
});

test('M2: an access request that ends without approval is said in the status', async (t) => {
  const s = await setup(t, {
    pinned: true,
    connect: false,
    gateway: { registerAnswer: () => ({ status: 400, body: { error: 'Error during register.' } }) },
  });
  s.gladys.fake.config = { gateway_address: s.gw.address };
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  await within(s.app.requestAccess(), 'click');
  await waitFor(() => /without approval/.test(s.message()), 'the cause in the status');
});

test('M4: command values are strict decimals', () => {
  const gladys = createFakeGladys();
  const model = buildModel((type, id) => gladys.externalIds(type, id), {
    gateway: 'snX',
    functions: functionsOf(fixtureFunctions()),
    scenes: scenesOf(fixtureScenes()),
  });
  const setpoint = model.writers.get('ext:test-integration:function:snX_idrtr1:setpoint');
  for (const v of ['0x10', '1e1', ' 22 ', '22 ', '+21', '']) {
    assert.throws(() => setpoint.write(v), /badValue/, JSON.stringify(v));
  }
  assert.equal(setpoint.write('21.5').value, '21.5');
  assert.equal(setpoint.write(21).value, '21.0');
});

test('M5: a Retry-After date is compared with the Date of the answer, never the local clock', () => {
  const date = 'Wed, 05 Nov 2025 12:00:00 GMT';
  assert.equal(retryAfterOf('Wed, 05 Nov 2025 12:10:00 GMT', date), 600_000);
  assert.equal(retryAfterOf('Wed, 05 Nov 2025 12:10:00 GMT', undefined), undefined);
  assert.equal(retryAfterOf('120', undefined), 120_000);
  assert.equal(retryAfterOf('1.5', undefined), 1500, 'decimal seconds (r2)');
  assert.equal(retryAfterOf('90.5', undefined), 90_500);
  assert.equal(retryAfterOf('120.1234', undefined), 120_123, 'any number of decimals (r3)');
  assert.equal(retryAfterOf(' 30.000001 ', undefined), 30_000);
  assert.equal(retryAfterOf('1e3', date), undefined);
});

test('M7: port 0 is not an address', () => {
  assert.equal(parseAddress('192.168.1.30:0').error, 'invalid');
  assert.equal(normalizeConfig({ gateway_address: '192.168.1.30:0' }).error, 'invalid');
});

test('press features keep their ids (frozen)', () => {
  assert.match(feature('idrock1', 'press_up'), /:function:snJH0012345678_idrock1:press_up$/);
});

test('a copy does not move the press window: a press 1.3 s after the click counts, even 0.3 s after its copy', async (t) => {
  const s = await setup(t);
  await waitFor(() => s.app.liveState === 'live', 'live');
  const presses = () =>
    s.fake.states.filter((x) => x.device_feature_external_id === feature('idrock1', 'press_up'))
      .length;
  const press = async () => {
    s.gw.setValue('idrock1-00c', 'up_request', 1);
    s.gw.setValue('idrock1-00c', 'up_request', 0);
    await pause(60);
  };
  await press();
  await s.advance(1000);
  await press(); // the copy
  await s.advance(300);
  await press(); // a new click
  await s.flush();
  assert.equal(presses(), 2);
});

test('a certificate refused at the handshake is no read: once trusted, the gateway is read at once', async (t) => {
  const s = await setup(t);
  const port = s.gw.port;
  await s.gw.close();
  const other = await fakeGateway({ port, cert: certs.impostor });
  t.after(() => other.close());
  // The first read due (the socket lost: at the interval) finds the changed certificate.
  await waitFor(() => s.app.liveState === 'down', 'the socket lost');
  await s.advance(61_000);
  await waitFor(() => /certificate of the gateway changed/.test(s.message()), 'the status');
  await within(s.app.trustCertificate(), 'click 1');
  await within(s.app.trustCertificate(), 'click 2');
  await waitFor(async () => {
    await s.advance(0);
    return other.count('GET /functions/') >= 1;
  }, 'read at once');
});

test('a stop kept for want of a pin leaves first once Test pins the certificate', async (t) => {
  const s = await setup(t, { pinned: false, memory: null, create: false, connect: false });
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  const device = {
    external_id: 'ext:test-integration:function:snJH0012345678_idlight1',
    params: [
      { name: 'JUNG_FUNCTION', value: 'idlight1' },
      { name: 'JUNG_SWITCH', value: LIGHT },
    ],
  };
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  const ack = await within(
    s.fake.setValue(device, { external_id: `${device.external_id}:on` }, 0),
    'ack',
  );
  assert.equal(ack.success, false, 'kept: no pin yet');
  assert.equal(s.gw.requests.length, 0);
  await within(s.app.testConnection(), 'test');
  await waitFor(() => s.gw.value(LIGHT, 'switch') === '0', 'the stop sent');
  assert.equal(s.gw.requests[0].method, 'PATCH', 'before the test reads');
});

// --- Review r2 -----------------------------------------------------------------------

test('r2 I4: a read made by Test puts off the planned read to the interval after it', async (t) => {
  const s = await setup(t, { config: { live_updates: false, poll_interval: 30 } });
  const reads = () => s.gw.count('GET /functions/');
  // The planned read is late (as when Test is clicked right at its due time).
  s.clock.timers.clearTimeout(s.app.readTimer);
  await s.advance(31_000);
  const before = reads();
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Connection OK/);
  assert.equal(reads(), before + 1);
  s.app.scheduleRead(s.app.generation, 0);
  await s.advance(0);
  await pause(50);
  assert.equal(reads(), before + 1, 'the planned read waits for the interval');
  await s.advance(29_000);
  await pause(50);
  assert.equal(reads(), before + 1);
  await s.advance(1500);
  await waitFor(() => reads() === before + 2, 'the next read at the interval');
});

test('r2: while the token is refused or another gateway answers, Test tries at once (10 s spacing)', async (t) => {
  const s = await setup(t);
  s.app.refuseToken();
  let result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Connection OK/);
  assert.equal(s.app.blocked, false);
  s.gw.serial = 'JH4242';
  s.app.identity = { ...s.app.identity, mismatch: 'snJH4242', verified: false };
  await s.advance(10_001);
  result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Connection OK/);
  assert.equal(s.store.data.identities[s.gw.address], 'snJH4242');
});

test('r2: a new token saved while running reads at once (another session)', async (t) => {
  const s = await setup(t);
  const reads = s.gw.count('GET /functions/');
  s.gw.token = OTHER_TOKEN;
  await within(s.fake.configUpdated({ ...s.raw, api_token: OTHER_TOKEN }), 'config');
  await waitFor(async () => {
    await s.advance(0);
    return s.gw.count('GET /functions/') > reads;
  }, 'the read with the new token');
});

// --- Review r3 -----------------------------------------------------------------------

const until = (s, fn, what) =>
  waitFor(async () => {
    await s.advance(0);
    return fn();
  }, what);

test('r3 I5: a Test that lifts a refused token takes its read: online at once, no second read', async (t) => {
  const s = await setup(t, { config: { live_updates: false, poll_interval: 600 } });
  s.gw.token = OTHER_TOKEN;
  await s.advance(600_000);
  await waitFor(() => s.app.blocked, 'refused by the function list');
  assert.equal(s.app.online, false);
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  const kept = await s.fire('idlight1', 'on', 0);
  assert.equal(kept.success, false, 'kept while the token is refused');
  s.gw.token = TOKEN;
  const reads = s.gw.count('GET /functions/');
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Connection OK/);
  await until(s, () => s.app.online, 'online right after the test');
  assert.match(s.message(), /Connected/);
  assert.equal(s.gw.count('GET /functions/'), reads + 1, 'the list of the test, read once');
  await waitFor(() => s.gw.value(LIGHT, 'switch') === '0', 'the kept stop sent');
  const ack = await s.fire('iddim1', 'brightness', 40);
  assert.equal(ack.success, true, err(ack));
  // The next read at the interval after the test's.
  await s.advance(590_000);
  await pause(50);
  assert.equal(s.gw.count('GET /functions/'), reads + 1);
  await s.advance(11_000);
  await waitFor(() => s.gw.count('GET /functions/') === reads + 2, 'the read at the interval');
});

test('r3 I5: the first Test, pinning the certificate, takes its read: online at once', async (t) => {
  const s = await setup(t, {
    pinned: false,
    memory: null,
    connect: false,
    config: { live_updates: false, poll_interval: 600 },
  });
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  assert.match(s.message(), /not pinned/);
  assert.equal(s.gw.requests.length, 0);
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Connection OK.*certificate pinned/);
  await until(s, () => s.app.online, 'online right after the test');
  assert.ok(s.fake.discoveredDevices.length > 0, 'the Discovery from the list of the test');
  await s.advance(590_000);
  await pause(50);
  assert.equal(s.gw.count('GET /functions/'), 1, 'no second read before the interval');
});

test('r3 I5: a Test at the due time while connected: its list reaches the devices, read once', async (t) => {
  const s = await setup(t, { config: { live_updates: false, poll_interval: 30 } });
  s.clock.timers.clearTimeout(s.app.readTimer);
  await s.advance(31_000);
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  const reads = s.gw.count('GET /functions/');
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Connection OK/);
  await s.flush();
  assert.equal(s.lastState('idlight1', 'on'), 1, 'the value read by the test');
  assert.equal(s.gw.count('GET /functions/'), reads + 1);
});

test('r3: a Test read that left before a command never undoes it', async (t) => {
  const s = await setup(t, { config: { live_updates: false, poll_interval: 30 } });
  s.clock.timers.clearTimeout(s.app.readTimer);
  await s.advance(31_000);
  // The list as it was when the request of the test came in, answered late.
  let snapshot;
  s.gw.latency = (r) => {
    if (r.path !== '/functions/') return 0;
    snapshot = structuredClone(s.gw.functions);
    return 600;
  };
  s.gw.replyFor = (r) =>
    r.path === '/functions/' && snapshot ? { status: 200, body: snapshot } : undefined;
  const testing = s.app.testConnection();
  await waitFor(() => snapshot, 'the read of the test sent');
  const ack = await s.fire('iddim1', 'brightness', 40);
  assert.equal(ack.success, true, err(ack));
  assert.match((await within(testing, 'test')).en, /Connection OK/);
  await s.flush();
  assert.equal(s.lastState('iddim1', 'brightness'), 40);
});

test('r3: a Test that ends after another token was saved gives the new session nothing', async (t) => {
  const s = await setup(t, { config: { live_updates: false } });
  s.app.refuseToken();
  // The old token accepted, slowly; the new one refused by the function list.
  s.gw.latency = (r) => (r.path === '/functions/' && r.token === TOKEN ? 800 : 0);
  s.gw.replyFor = (r) =>
    r.path === '/functions/' && r.token === OTHER_TOKEN ? { status: 401, body: {} } : undefined;
  const before = s.gw.count('GET /functions/');
  const testing = s.app.testConnection();
  await waitFor(() => s.gw.count('GET /functions/') > before, 'the read of the test sent');
  await within(s.fake.configUpdated({ ...s.raw, api_token: OTHER_TOKEN }), 'config');
  await until(s, () => s.app.blocked, 'the new token refused');
  assert.match((await within(testing, 'test')).en, /Connection OK/);
  await s.advance(0);
  await pause(30);
  assert.equal(s.app.blocked, true, 'the refusal of the new token stays');
  assert.ok(s.store.data.refused);
  assert.equal(s.app.online, false);
});

test('r3: a Test refused for an older token never marks the new one refused', async (t) => {
  const s = await setup(t, { config: { live_updates: false } });
  s.clock.timers.clearTimeout(s.app.readTimer);
  await s.advance(61_000);
  // The old token refused, slowly; the new one accepted.
  s.gw.token = OTHER_TOKEN;
  s.gw.latency = (r) => (r.path === '/functions/' && r.token === TOKEN ? 800 : 0);
  const before = s.gw.count('GET /functions/');
  const testing = s.app.testConnection();
  await waitFor(() => s.gw.count('GET /functions/') > before, 'the read of the test sent');
  await within(s.fake.configUpdated({ ...s.raw, api_token: OTHER_TOKEN }), 'config');
  await until(s, () => s.app.online, 'the new token read');
  assert.match((await within(testing, 'test')).en, /refused/);
  await pause(30);
  assert.equal(s.app.blocked, false);
  assert.equal(s.store.data.refused ?? null, null);
});

test('r3: during a 429 pause, neither Test nor Request access sends anything', async (t) => {
  const s = await setup(t, { config: { live_updates: false } });
  s.gw.replyFor = (r) =>
    r.path === '/functions/'
      ? { status: 429, body: {}, headers: { 'retry-after': '600' } }
      : undefined;
  await s.advance(61_000);
  await waitFor(() => s.app.paused(), 'paused');
  s.gw.replyFor = () => undefined;
  // The interval is over, the pause is not.
  await s.advance(120_000);
  const count = s.gw.requests.length;
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /No test during the pause/);
  const access = await within(s.app.requestAccess(), 'access');
  assert.match(access.en, /no access request/);
  await pause(50);
  assert.equal(s.gw.requests.length, count, 'nothing sent');
  // A stop still leaves.
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  const ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, err(ack));
});

test('r3: a close sent again after a read leaves once for that read (no quick retries)', async (t) => {
  const s = await setup(t);
  s.gw.drop = (r) => r.method === 'PATCH';
  const ack = s.fire('idblind1', 'state', -1);
  for (let i = 0; i < 10; i += 1) {
    await s.advance(100);
    await pause(20);
  }
  await s.advance(3500);
  assert.equal((await ack).success, false);
  const sets = () => s.gw.sets('idblind1-001').length;
  assert.equal(sets(), 3, 'the click and its two quick retries');
  const reads = () => s.gw.count('GET /functions/idblind1/datapoints/idblind1-001');
  const before = reads();
  // The stop timer (5 s after the click): a read of the level, then one send.
  await s.advance(500);
  await waitFor(() => sets() === 4, 'sent again after the read');
  assert.equal(reads(), before + 1);
  for (let i = 0; i < 8; i += 1) {
    await s.advance(50);
    await pause(20);
  }
  assert.equal(sets(), 4, 'no quick retry after a read');
});

test('r3: an identity a Test accepts after another address was saved is not given to it', async (t) => {
  const s = await setup(t, { config: { live_updates: false } });
  const gw2 = await fakeGateway();
  t.after(() => gw2.close());
  s.gw.serial = 'JH4242';
  s.app.identity = { ...s.app.identity, mismatch: 'snJH4242', verified: false };
  // /data keeps the new identity slowly.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const save = s.store.save.bind(s.store);
  s.store.save = async (data) => {
    if (data.identities?.[s.gw.address] === 'snJH4242') await gate;
    return save(data);
  };
  const testing = s.app.testConnection();
  await waitFor(() => s.app.memory.identities[s.gw.address] === 'snJH4242', 'the identity kept');
  await within(
    s.fake.configUpdated({
      ...s.raw,
      gateway_address: gw2.address,
      certificate_fingerprint: gw2.fingerprint,
    }),
    'config',
  );
  await until(s, () => s.app.online, 'the new gateway read');
  release();
  assert.match((await within(testing, 'test')).en, /Connection OK/);
  await s.advance(0);
  await pause(30);
  assert.equal(s.app.config.address, gw2.address);
  assert.equal(s.app.identity.key, 'snJH0012345678', 'the identity of the gateway now configured');
  assert.equal(s.app.identity.mismatch, undefined);
});

test('r3: a new token saved while running is tried, even when its 6-bit mark is the refused one', async (t) => {
  const s = await setup(t, { config: { live_updates: false } });
  s.gw.token = OTHER_TOKEN;
  s.app.refuseToken();
  // The 1-in-64 case: the mark of the new token equals the one kept for the refused token.
  s.app.memory.refused.mark = tokenMark(s.app.memory.refused.salt, OTHER_TOKEN);
  s.gw.setValue(LIGHT, 'switch', 1, { push: false });
  await s.fire('idlight1', 'on', 0);
  await within(s.fake.configUpdated({ ...s.raw, api_token: OTHER_TOKEN }), 'config');
  assert.equal(s.app.blocked, false);
  await waitFor(() => s.gw.value(LIGHT, 'switch') === '0', 'the kept stop sent with the new token');
  await until(s, () => s.app.online, 'read with the new token');
  assert.equal(s.store.data.refused ?? null, null);
});
