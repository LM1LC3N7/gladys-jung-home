// -----------------------------------------------------------------------------
// Lifecycle against the simulated gateway: start, reads, live socket, token,
// pauses, identity, certificate, /data, Gladys reconnections.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certs } from './kit/certs.mjs';
import { OTHER_TOKEN, TOKEN, fakeGateway } from './helpers/fakeGateway.js';
import { device, feature, pause, setup, waitFor, within } from './helpers/setup.js';

test('reads the gateway, offers the devices, publishes the states, then goes live', async (t) => {
  const s = await setup(t);
  assert.equal(s.status().connected, true, s.message());
  const ids = s.fake.discoveredDevices.map((d) => d.external_id);
  assert.ok(ids.includes(device('idlight1')), ids.join());
  assert.ok(ids.includes('ext:test-integration:scene:snJH0012345678_id0001'));
  await waitFor(() => s.lastState('iddim1', 'brightness') === 30, 'brightness');
  assert.equal(s.lastState('idblind1', 'position'), 70);
  assert.equal(s.lastState('idrtr1', 'setpoint'), 21.5);
  assert.equal(s.lastState('idrtr1', 'q010'), 20);
  assert.equal(s.lastState('idsock1', 'q010'), 5);
  assert.equal(s.lastState('idmeas1', 'q010'), 120);
  await waitFor(() => s.app.liveState === 'live', 'the live socket');
  assert.match(s.message(), /live updates on/);
  // A change pushed on the socket reaches Gladys.
  s.gw.setValue('iddim1-002', 'brightness', 75);
  await waitFor(async () => {
    await s.flush();
    return s.lastState('iddim1', 'brightness') === 75;
  }, 'the pushed change');
  // With the socket, the list is read again every 5 minutes, not every minute.
  const reads = s.gw.count('GET /functions/');
  await s.advance(120_000);
  await pause(30);
  assert.equal(s.gw.count('GET /functions/'), reads);
  await s.advance(200_000);
  await waitFor(() => s.gw.count('GET /functions/') === reads + 1, 'the resync');
});

test('rocker presses: one click per press, the copy of the device firmware dropped, never from a snapshot', async (t) => {
  const s = await setup(t);
  await waitFor(() => s.app.liveState === 'live', 'live');
  const presses = () =>
    s.fake.states.filter((x) => x.device_feature_external_id === feature('idrock1', 'press_up'));
  s.gw.setValue('idrock1-00c', 'up_request', 1);
  s.gw.setValue('idrock1-00c', 'up_request', 0);
  // The copy ~1 s later (here at once: within 1.2 s of the clock).
  s.gw.setValue('idrock1-00c', 'up_request', 1);
  s.gw.setValue('idrock1-00c', 'up_request', 0);
  await pause(80);
  await s.flush();
  assert.equal(presses().length, 1);
  await s.advance(1300);
  s.gw.setValue('idrock1-00c', 'up_request', 1);
  await pause(80);
  await s.flush();
  assert.equal(presses().length, 2, 'a press after the window counts');
  // A snapshot holding "1" is no press.
  s.gw.setValue('idrock1-00d', 'down_request', 1, { push: false });
  s.gw.broadcast({ type: 'functions', data: s.gw.functions });
  await pause(80);
  await s.flush();
  assert.equal(
    s.fake.states.filter((x) => x.device_feature_external_id === feature('idrock1', 'press_down'))
      .length,
    0,
  );
});

test('getConfig() failing in "connected" is tried again, spaced, without end, then starts', async (t) => {
  let fails = 3;
  let calls = 0;
  const s = await setup(t, {
    connect: false,
    getConfig: async function getConfig() {
      calls += 1;
      // The SDK's own resynchronization (first call) is answered.
      if (calls > 1 && fails > 0) {
        fails -= 1;
        throw new Error('Gladys busy');
      }
      return s.raw;
    },
  });
  await within(s.gladys.connect(), 'connect');
  await waitFor(() => /could not be read/.test(s.message()), 'the status');
  for (const wait of [5000, 15_000, 30_000]) {
    await s.advance(wait);
    await pause(20);
  }
  await s.online();
  assert.match(s.message(), /Connected/);
  assert.equal(calls, 5);
  // A reconnection to Gladys whose getConfig() fails once: the session goes on, tried again.
  fails = 1;
  s.gladys.emit('connected');
  await waitFor(() => calls === 6, 'the call');
  await s.advance(60_000);
  await waitFor(() => calls === 7, 'tried again');
  assert.equal(s.app.online, true);
});

test('a refused token: nothing tried again, even after a restart, until a new token or the Test button', async (t) => {
  const s = await setup(t);
  s.gw.token = OTHER_TOKEN;
  await s.advance(300_000);
  await waitFor(() => s.app.blocked, 'refused');
  assert.match(s.message(), /refused the token/);
  assert.ok(s.store.data.refused, 'kept in /data');
  const count = s.gw.requests.length;
  await s.advance(3600_000);
  await pause(50);
  assert.equal(s.gw.requests.length, count, 'never tried again by itself');
  // A restart with the same token: still refused, nothing sent.
  s.app.memoryState = 'unloaded';
  await within(s.app.start(s.raw), 'restart');
  await s.advance(600_000);
  await pause(50);
  assert.equal(s.gw.requests.length, count);
  assert.equal(s.app.blocked, true);
  // The Test button with the gateway accepting it again: lifted.
  s.gw.token = TOKEN;
  const result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /Connection OK/);
  assert.equal(s.store.data.refused, null);
  await s.advance(60_000);
  await s.online();
});

test('a 401 on a secondary read is not a refusal when the token is accepted elsewhere', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) => (r.path === '/scenes/' ? { status: 500, body: {} } : undefined);
  await s.advance(300_000);
  await waitFor(() => s.gw.count('GET /scenes/') >= 2, 'the read');
  await pause(30);
  assert.equal(s.app.online, true, 'a failing scene list never stops the values');
  assert.equal(s.app.blocked, false);
});

test('429: every read paused (kept across a restart), the stops still leave', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) =>
    r.path === '/functions/'
      ? { status: 429, body: {}, headers: { 'retry-after': '600' } }
      : undefined;
  await s.advance(300_000);
  await waitFor(() => s.app.paused(), 'paused');
  // Even a Scan long after the last read does not read during the pause.
  const during = s.gw.count('GET /functions/');
  await s.advance(120_000);
  await within(s.fake.scanRequest(), 'scan');
  await pause(50);
  assert.equal(s.gw.count('GET /functions/'), during, 'no read on Scan during the pause');
  assert.ok(s.store.data.pausedUntil > 0);
  assert.match(s.message(), /slow down/);
  s.gw.replyFor = () => undefined;
  const count = s.gw.count('GET /functions/');
  await s.advance(50_000);
  await pause(30);
  assert.equal(s.gw.count('GET /functions/'), count, 'no read during the pause');
  const ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, ack.error);
  s.app.memoryState = 'unloaded';
  await within(s.app.start(s.raw), 'restart');
  assert.ok(s.app.paused(), 'the pause outlives a restart');
  await s.advance(500_000);
  await waitFor(() => s.gw.count('GET /functions/') > count, 'read after the pause');
});

test('a restart never reads sooner than the interval after the last read (/data)', async (t) => {
  const s = await setup(t);
  assert.ok(s.store.data.lastReadAt, 'the time of the read kept before it');
  const count = s.gw.count('GET /functions/');
  s.app.memoryState = 'unloaded';
  s.app.stop();
  await within(s.app.start(s.raw), 'restart');
  await s.advance(55_000);
  await pause(30);
  assert.equal(s.gw.count('GET /functions/'), count);
  await s.advance(6000);
  await waitFor(() => s.gw.count('GET /functions/') === count + 1, 'the read');
});

test('identity: learnt once, a weaker or missing answer is unreadable, another serial refuses commands', async (t) => {
  const s = await setup(t);
  assert.equal(s.store.data.identities[s.gw.address], 'snJH0012345678');
  // Serial unreadable after a restart: the known devices still get their
  // states, only the stops are sent.
  s.gw.replyFor = (r) =>
    r.path === '/config/parameter/system_serial' ? { status: 500, body: {} } : undefined;
  s.app.stop();
  await within(s.app.start(s.raw, { fresh: true }), 'restart');
  await s.advance(60_000);
  await s.online();
  assert.equal(s.app.identity.verified, false);
  assert.match(s.message(), /only stops are sent/);
  let ack = await s.fire('idlight1', 'on', 1);
  assert.match(ack.error, /not read again|pas encore relu/);
  ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, ack.error);
  // A serial endpoint gone (404) and only a MAC: never a downgrade.
  s.gw.replyFor = () => undefined;
  s.gw.serial = null;
  s.app.stop();
  await within(s.app.start(s.raw, { fresh: true }), 'restart');
  await s.advance(60_000);
  await s.online();
  assert.equal(s.app.identity.verified, false);
  assert.equal(s.app.identity.key, 'snJH0012345678');
  assert.equal(
    s.app.identity.mismatch,
    undefined,
    'a weaker answer is unreadable, not another gateway',
  );
  assert.equal(s.app.identity.unreadable, true);
  // Another serial: commands refused, devices not offered under it.
  s.gw.serial = 'JH9999';
  s.app.stop();
  await within(s.app.start(s.raw, { fresh: true }), 'restart');
  await s.advance(60_000);
  await s.online();
  assert.equal(s.app.identity.mismatch, 'snJH9999');
  assert.match(s.message(), /Another gateway/);
  ack = await s.fire('idlight1', 'on', 1);
  assert.equal(ack.success, false);
  // A stop still leaves, to the address typed.
  s.gw.setValue('idlight1-001', 'switch', 1, { push: false });
  ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(s.gw.value('idlight1-001', 'switch'), '0');
  // The Test button accepts it.
  s.app.lastTest = undefined;
  await within(s.app.testConnection(), 'test');
  assert.equal(s.store.data.identities[s.gw.address], 'snJH9999');
});

test('a firmware without the serial: the MAC is the identity, learnt once', async (t) => {
  const s = await setup(t, { gateway: { serial: null } });
  assert.equal(s.store.data.identities[s.gw.address], 'mac001122334455');
  assert.ok(
    s.fake.discoveredDevices.some((d) => d.external_id.includes('mac001122334455_idlight1')),
  );
});

test('certificate: a changed one stops everything (fingerprint shown); trusted in two clicks only', async (t) => {
  const s = await setup(t);
  const port = s.gw.port;
  await s.gw.close();
  const other = await fakeGateway({ port, cert: certs.impostor });
  t.after(() => other.close());
  await s.advance(300_000);
  await waitFor(() => /certificate of the gateway changed/.test(s.message()), 'the status');
  assert.ok(s.message().includes(certs.impostor.fingerprint256));
  assert.equal(other.requests.length, 0, 'nothing sent to it');
  const pending = s.fire('idlight1', 'on', 0);
  await pause(50);
  await s.advance(3500);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /certificate changed|certificat a changé/);
  assert.equal(other.requests.length, 0, 'not even the stop: the token never leaves');
  let result = await within(s.app.trustCertificate(), 'first click');
  assert.match(result.en, /Click again within 2 minutes/);
  assert.equal(s.store.data.pins[other.address], certs.device.fingerprint256, 'not trusted yet');
  await s.advance(130_000);
  result = await within(s.app.trustCertificate(), 'late click');
  assert.match(result.en, /Click again/, 'too late: asks again');
  result = await within(s.app.trustCertificate(), 'second click');
  assert.match(result.en, /New certificate trusted/);
  assert.equal(s.store.data.pins[other.address], certs.impostor.fingerprint256);
  await waitFor(async () => {
    await s.advance(100);
    return other.requests.some((r) => r.method === 'PATCH');
  }, 'the kept stop sent');
  await s.advance(60_000);
  await waitFor(() => s.app.online, 'online again');
});

test('the first certificate is pinned on a click only; an unreadable /data never learns one', async (t) => {
  const s = await setup(t, { pinned: false, memory: null, create: false, connect: false });
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  await waitFor(() => /not pinned yet/.test(s.message()), 'the status');
  assert.equal(s.gw.requests.length, 0, 'nothing sent before the pin');
  // /data unreadable: the click shows the fingerprint, keeps nothing.
  s.app.memoryState = 'unreadable';
  let result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /could not keep it/);
  assert.ok(result.en.includes(s.gw.fingerprint));
  s.app.memoryState = 'loaded';
  s.app.lastTest = undefined;
  result = await within(s.app.testConnection(), 'test');
  assert.match(result.en, /certificate pinned/);
  assert.equal(s.store.data.pins[s.gw.address], s.gw.fingerprint);
  await s.advance(1000);
  await s.online();
});

test('a fingerprint typed in the configuration is the pin', async (t) => {
  const s = await setup(t, { pinned: false, memory: null, connect: false, config: {} });
  s.gladys.fake.config = {
    ...s.raw,
    certificate_fingerprint: s.gw.fingerprint.replace(/:/g, '').toLowerCase(),
  };
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  await s.online();
  assert.equal(s.store.data.pins[s.gw.address], s.gw.fingerprint);
});

test('/data unreadable: nothing learnt nor written over it; said in the status', async (t) => {
  const s = await setup(t, { connect: false });
  s.store.failLoad = true;
  s.gladys.fake.config = { ...s.raw, certificate_fingerprint: s.gw.fingerprint };
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  await s.online();
  assert.match(s.message(), /\/data is unreadable/);
  await s.fire('idlight1', 'on', 0);
  assert.equal(s.store.saves, 0, 'never written over');
});

test('/data slow at start: bounded, the start goes on', async (t) => {
  const s = await setup(t, { connect: false });
  s.store.hangLoad = true;
  s.gladys.fake.config = { ...s.raw, certificate_fingerprint: s.gw.fingerprint };
  const connecting = s.gladys.connect();
  await waitFor(() => s.app.started, 'started');
  await pause(20);
  await s.advance(2000);
  await within(connecting, 'connect');
  await s.online();
  assert.equal(s.app.memoryState, 'unreadable');
});

test('a reconnection to Gladys sends status and Discovery again, never an old value as new', async (t) => {
  const s = await setup(t);
  await s.flush();
  const states = s.fake.states.length;
  const discoveries = s.fake.requests.filter(
    (r) => r.path === '/discovered-devices' || r.path.includes('discover'),
  ).length;
  s.gladys.emit('connected');
  await pause(80);
  await s.flush();
  assert.equal(s.fake.states.length, states, 'no state published again');
  assert.ok(
    s.fake.requests.filter((r) => r.path === '/discovered-devices' || r.path.includes('discover'))
      .length > discoveries,
  );
  assert.equal(s.status().connected, true);
});

test('a device created long after the last read gets no stale value', async (t) => {
  const s = await setup(t, { create: false });
  await waitFor(() => s.app.liveState === 'live', 'live');
  await pause(50);
  const dim = s.fake.discoveredDevices.find((d) => d.external_id === device('iddim1'));
  await s.advance(150_000);
  await within(s.fake.deviceCreated(dim), 'created');
  await s.flush();
  assert.equal(s.lastState('iddim1', 'brightness'), undefined);
  const light = s.fake.discoveredDevices.find((d) => d.external_id === device('idlight1'));
  await s.advance(200_000);
  await waitFor(() => s.gw.count('GET /functions/') >= 2, 'a new read');
  await pause(30);
  await within(s.fake.deviceCreated(light), 'created');
  await s.flush();
  assert.equal(s.lastState('idlight1', 'on'), 0, 'a fresh value is sent');
});

test('Scan: never a read sooner than the interval', async (t) => {
  const s = await setup(t);
  const count = s.gw.count('GET /functions/');
  await within(s.fake.scanRequest(), 'scan');
  await pause(30);
  assert.equal(s.gw.count('GET /functions/'), count);
  await s.advance(61_000);
  await within(s.fake.scanRequest(), 'scan');
  await waitFor(() => s.gw.count('GET /functions/') === count + 1, 'the read');
});

test('Request access: pins the certificate, one registration "Gladys", the token saved and used', async (t) => {
  let release;
  const s = await setup(t, {
    pinned: false,
    memory: null,
    connect: false,
    gateway: {
      registerAnswer: (r) =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              r.json?.user_name === 'Gladys'
                ? { status: 200, body: { token: TOKEN } }
                : { status: 400, body: {} },
            );
        }),
    },
  });
  s.gladys.fake.config = { gateway_address: s.gw.address };
  await within(s.gladys.connect(), 'connect');
  await s.advance(0);
  assert.match(s.message(), /No token yet/);
  const result = await within(s.app.requestAccess(), 'click');
  assert.match(result.en, /Certificate pinned/);
  assert.match(result.en, /accept "Gladys"/);
  await waitFor(() => release, 'the request');
  const again = await within(s.app.requestAccess(), 'second click');
  assert.match(again.en, /already waiting/);
  assert.equal(s.gw.count('POST /register'), 1);
  release();
  await waitFor(() => s.gladys.fake.config.api_token === TOKEN, 'the token saved');
  await s.advance(0);
  await s.online();
});

test('no supported_options on any published feature, or only ones the core accepts', async (t) => {
  const s = await setup(t);
  for (const d of s.fake.discoveredDevices) {
    for (const f of d.features) {
      assert.equal(f.supported_options, undefined, f.external_id);
      assert.ok(
        !(f.category === 'switch' && /idsock/.test(f.external_id)),
        'no switch for an unsafe socket',
      );
    }
  }
});
