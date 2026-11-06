// -----------------------------------------------------------------------------
// Commands and stops against the simulated gateway. Stops (switch off, cover
// stop and close, frost protection) are never held back; a switch-off is kept
// until a read started after the gateway's answer shows it applied.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OTHER_TOKEN, TOKEN } from './helpers/fakeGateway.js';
import { pause, setup, waitFor, within } from './helpers/setup.js';

const PATCH_LIGHT = 'idlight1-001';
const ackError = (ack) => ack.error ?? '';

test('switch off: sent at once, success once a read shows it, nothing kept after', async (t) => {
  const s = await setup(t);
  s.gw.setValue(PATCH_LIGHT, 'switch', 1);
  const ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.value(PATCH_LIGHT, 'switch'), '0');
  await waitFor(() => s.app.guards.size === 0, 'the guard dropped once read back applied');
  await waitFor(() => (s.store.data.guards ?? []).length === 0, '/data without the kept stop');
});

test('a stop is never held back: 429 pause, unverified identity, stalled read, full queue, frozen /data', async (t) => {
  const s = await setup(t, { config: { safe_sockets: 'idsock2' } });
  // Every non-protective path is closed or busy.
  s.app.pauseEnd = s.clock.monotonic() + 3600_000;
  s.app.identity = { ...s.app.identity, verified: false };
  s.store.hang = true;
  s.gw.latency = (r) => (r.method === 'GET' && r.path === '/functions/' ? 3000 : 0);
  s.app.slotsUsed = 6;
  s.app.reading = true;
  for (const f of ['idlight1', 'iddim1', 'idsock2'])
    s.gw.setValue(`${f}-001`, 'switch', 1, { push: false });
  const t0 = performance.now();
  const acks = await Promise.all([
    s.fire('idlight1', 'on', 0),
    s.fire('iddim1', 'on', 0),
    s.fire('idsock2', 'on', 0),
    s.fire('idrtr1', 'frost', 1),
  ]);
  assert.ok(performance.now() - t0 < 1500, 'never waited for the read, the queue nor /data');
  for (const ack of acks) assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.value('idlight1-001', 'switch'), '0');
  assert.equal(s.gw.value('iddim1-001', 'switch'), '0');
  assert.equal(s.gw.value('idsock2-001', 'switch'), '0');
  assert.equal(s.gw.value('idrtr1-001', 'temperature_ctrl_preset'), 'frost');
  // And a non-protective command is refused at once in the same state.
  const on = await s.fire('idlight1', 'on', 1);
  assert.equal(on.success, false);
});

test('a stop pressed while the token is refused: kept, nothing sent, leaves first with a new token', async (t) => {
  const s = await setup(t);
  await waitFor(() => s.app.liveState === 'live', 'live');
  s.gw.token = OTHER_TOKEN;
  s.app.refuseToken();
  s.gw.setValue(PATCH_LIGHT, 'switch', 1, { push: false });
  const before = s.gw.requests.length;
  const ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, false);
  assert.match(ackError(ack), /jeton refusé|token refused/i);
  await s.advance(20_000);
  await pause(50);
  assert.equal(s.gw.requests.length, before, 'nothing tried while the token is refused');
  assert.equal(s.store.data.guards.length, 1, 'kept in /data');
  // A new token is saved: the stop leaves before any read.
  s.gw.latency = (r) => (r.path === '/functions/' ? 300 : 0);
  await within(s.gladys.fake.configUpdated({ ...s.raw, api_token: OTHER_TOKEN }), 'config');
  await waitFor(
    () => s.gw.value(PATCH_LIGHT, 'switch') === '0',
    'the stop sent with the new token',
  );
  const after = s.gw.requests.slice(before);
  assert.equal(after[0].method, 'PATCH', 'the stop is the first request');
  assert.equal(after[0].token, OTHER_TOKEN);
});

test('a stop pressed while the token is refused leaves when the Test button succeeds', async (t) => {
  const s = await setup(t);
  s.app.refuseToken();
  s.gw.setValue(PATCH_LIGHT, 'switch', 1, { push: false });
  const ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, false);
  await s.advance(61_000);
  const result = await within(s.app.testConnection(), 'the test');
  assert.match(result.en, /Connection OK/);
  await waitFor(
    () => s.gw.value(PATCH_LIGHT, 'switch') === '0',
    'the kept stop sent after the test',
  );
  assert.equal(s.app.blocked, false);
});

test('a stop that never reached the gateway is not counted: sent again until it lands, no age limit', async (t) => {
  const s = await setup(t);
  s.gw.setValue(PATCH_LIGHT, 'switch', 1, { push: false });
  let down = true;
  // The connection is cut once the request is written: sent, never answered.
  s.gw.drop = (r) => down && r.method === 'PATCH';
  const ack = s.fire('idlight1', 'on', 0);
  await waitFor(() => s.gw.sets(PATCH_LIGHT).length >= 1, 'the first send');
  for (let i = 0; i < 10; i += 1) {
    await s.advance(100);
    await pause(20);
  }
  await s.advance(3500);
  const first = await ack;
  assert.equal(first.success, false);
  assert.match(ackError(first), /kept|gardé/i);
  assert.ok(s.gw.sets(PATCH_LIGHT).length >= 3, 'two quick retries within the budget');
  // Long after, still worked on; unanswered sends never count.
  for (let i = 0; i < 40; i += 1) {
    await s.advance(5000);
    await pause(10);
  }
  const guard = [...s.app.guards.values()][0];
  assert.equal(guard.answered, 0);
  assert.ok(s.gw.sets(PATCH_LIGHT).length > 10);
  await s.app.showStatus();
  assert.match(s.message(), /Stops kept: Hall Light/);
  down = false;
  for (let i = 0; i < 40 && s.gw.value(PATCH_LIGHT, 'switch') !== '0'; i += 1) {
    await s.advance(1000);
    await pause(20);
  }
  assert.equal(s.gw.value(PATCH_LIGHT, 'switch'), '0', 'the stop landed');
  await waitFor(() => s.app.guards.size === 0, 'applied, dropped');
});

test('a stop read back not applied: sent again, 4 answered sends at most, then shown and kept', async (t) => {
  const s = await setup(t);
  s.gw.setValue(PATCH_LIGHT, 'switch', 1, { push: false });
  s.gw.applySets = false;
  const ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, 'taken by the gateway');
  await waitFor(() => s.gw.sets(PATCH_LIGHT).length >= 4, 'resent after the reads');
  for (let i = 0; i < 5; i += 1) {
    await s.advance(5000);
    await pause(30);
  }
  assert.equal(s.gw.sets(PATCH_LIGHT).length, 4, 'never more than 4 answered sends');
  const guard = [...s.app.guards.values()][0];
  assert.equal(guard.stuck, true);
  await s.app.showStatus();
  assert.match(s.message(), /still not applied after 4 sends/);
  assert.equal(s.store.data.guards.length, 1, 'still kept');
  // Applied later (read again by the periodic read): dropped.
  s.gw.setValue(PATCH_LIGHT, 'switch', 0, { push: false });
  await s.advance(300_000);
  await waitFor(() => s.app.guards.size === 0, 'dropped on the read');
});

test('a newer command that left lifts the kept stop; one refused (4xx) does not', async (t) => {
  const s = await setup(t);
  s.gw.applySets = false;
  s.gw.setValue(PATCH_LIGHT, 'switch', 1, { push: false });
  await s.fire('idlight1', 'on', 0);
  await waitFor(() => s.app.guards.size === 1 && ![...s.app.guards.values()][0].inFlight, 'kept');
  s.gw.replyFor = (r) =>
    r.method === 'PATCH' ? { status: 423, body: { error: 'Device is locked' } } : undefined;
  await waitFor(() => !s.app.guardOf('idlight1')?.inFlight, 'idle');
  const refused = await s.fire('idlight1', 'on', 1);
  assert.match(ackError(refused), /Device is locked/);
  assert.equal(s.app.guards.size, 1, 'a refused command does not lift it');
  s.gw.replyFor = () => undefined;
  s.gw.applySets = true;
  await waitFor(() => !s.app.guardOf('idlight1')?.inFlight, 'idle');
  if (s.app.guardOf('idlight1')) {
    await s.fire('idlight1', 'on', 1);
  }
  await waitFor(() => s.app.guards.size === 0, 'lifted (or applied)');
  const sets = s.gw.sets(PATCH_LIGHT).length;
  await s.advance(30_000);
  await pause(50);
  assert.equal(s.gw.sets(PATCH_LIGHT).length, sets, 'never sent again after');
});

test('restart: a kept switch-off leaves first, before any read; a cover close is never replayed', async (t) => {
  const s = await setup(t, { connect: false });
  const address = s.gw.address;
  s.store.data = {
    pins: { [address]: s.gw.fingerprint },
    identities: { [address]: 'snJH0012345678' },
    lastReadAt: Date.UTC(2026, 0, 1),
    guards: [
      { address, fid: 'idlight1', dpid: 'idlight1-001', key: 'switch', value: '0', answered: 1 },
      { address, fid: 'idblind1', dpid: 'idblind1-001', key: 'level', value: '100', answered: 0 },
    ],
  };
  s.gw.setValue(PATCH_LIGHT, 'switch', 1, { push: false });
  await within(s.gladys.connect(), 'connect');
  await waitFor(() => s.gw.value(PATCH_LIGHT, 'switch') === '0', 'the kept stop sent at start');
  assert.equal(s.gw.requests[0].method, 'PATCH');
  assert.equal(s.gw.requests[0].path, '/functions/idlight1/datapoints/idlight1-001');
  assert.equal(s.gw.count('GET /functions/'), 0, 'no read yet (the interval after the last one)');
  assert.equal(s.gw.sets('idblind1-001').length, 0, 'a cover close is never replayed');
  await s.advance(59_000);
  await pause(50);
  assert.equal(s.gw.count('GET /functions/'), 0, 'still the interval after the last read');
  await s.advance(2000);
  await waitFor(() => s.gw.count('GET /functions/') === 1, 'the first read');
});

test('nothing sent before a stop leaves after it: a queued command is cancelled by the stop', async (t) => {
  const s = await setup(t);
  s.gw.latency = (r) => (r.method === 'PATCH' && r.json?.data?.[0]?.value === '20' ? 800 : 0);
  const slow = s.fire('idblind1', 'position', 80); // level 20, slow
  await waitFor(() => s.gw.sets('idblind1-001').length === 1, 'the slow one left');
  const queued = s.fire('idblind1', 'position', 40); // waits behind it
  await pause(20);
  const stop = await s.fire('idblind1', 'state', 0);
  assert.equal(stop.success, true, ackError(stop));
  const [a, b] = await Promise.all([slow, queued]);
  assert.equal(a.success, true, ackError(a));
  assert.equal(b.success, false);
  assert.match(ackError(b), /stop|arrêt/i);
  const values = s.gw.sets('idblind1-001').map((r) => r.json.data[0]);
  assert.deepEqual(values, [
    { key: 'level', value: '20' },
    { key: 'level_move', value: '0' },
  ]);
  await pause(50);
  assert.equal(s.app.guards.size, 0, 'a cover move is done once taken');
  assert.equal((s.store.data.guards ?? []).length, 0, 'never kept in /data');
});

test('a read started before a command never applies to it afterwards', async (t) => {
  const s = await setup(t);
  await s.flush();
  // The next read answers late with what the gateway had when it was asked.
  let stale;
  s.gw.replyFor = (r) =>
    r.method === 'GET' && r.path === '/functions/' && stale
      ? { status: 200, body: stale }
      : undefined;
  s.gw.latency = (r) => {
    if (r.method === 'GET' && r.path === '/functions/') {
      stale = JSON.parse(JSON.stringify(s.gw.functions));
      return 600;
    }
    return 0;
  };
  await s.advance(300_000);
  await waitFor(() => s.app.reading, 'the read in flight');
  const ack = await s.fire('idlight1', 'on', 1);
  assert.equal(ack.success, true, ackError(ack));
  await waitFor(() => !s.app.reading, 'the read done');
  await s.flush();
  assert.equal(s.lastState('idlight1', 'on'), 1, 'the older read did not put 0 back');
});

test('options: heating setpoints, scenes, unsafe sockets; option re-read right before sending', async (t) => {
  const s = await setup(t);
  const before = s.gw.requests.length;
  let ack = await s.fire('idrtr1', 'setpoint', 22);
  assert.match(ackError(ack), /Heating setpoints are not allowed|consignes de chauffage/);
  ack = await s.fireScene('id0001');
  assert.match(ackError(ack), /scenes are not allowed|scènes JUNG HOME/);
  ack = await s.fire('idsock2', 'on', 1);
  assert.equal(ack.success, false, 'no "on" feature on a socket not declared safe');
  assert.equal(s.gw.requests.length, before, 'nothing sent');
  await within(
    s.gladys.fake.configUpdated({
      ...s.raw,
      allow_heating_setpoints: true,
      allow_scenes: true,
      safe_sockets: 'idsock2',
    }),
    'config',
  );
  await s.online();
  ack = await s.fire('idrtr1', 'setpoint', 21.7);
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.value('idrtr1-001', 'temperature_ctrl'), '21.5');
  ack = await s.fire('idrtr1', 'setpoint', 35);
  assert.match(ackError(ack), /out of bounds|hors bornes/);
  ack = await s.fireScene('id0002');
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.count('POST /scenes/id0002'), 1);
  ack = await s.fire('idsock2', 'on', 1);
  assert.equal(ack.success, true, ackError(ack));
  // The option turned off while the command waits: refused right before the first byte.
  s.gw.latency = (r) => (r.method === 'PATCH' && r.path.includes('idrtr1') ? 600 : 0);
  const first = s.fire('idrtr1', 'setpoint', 20);
  await waitFor(() => s.gw.sets('idrtr1-001').length === 2, 'the first left');
  const second = s.fire('idrtr1', 'setpoint', 19);
  await pause(20);
  s.app.config = { ...s.app.config, allowHeating: false };
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.success, true, ackError(a));
  assert.match(ackError(b), /Heating setpoints are not allowed|consignes de chauffage/);
  assert.equal(s.gw.sets('idrtr1-001').length, 2);
});

test('frost protection is never held back by the heating option', async (t) => {
  const s = await setup(t);
  const ack = await s.fire('idrtr1', 'frost', 1);
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.value('idrtr1-001', 'temperature_ctrl_preset'), 'frost');
});

test('a Gladys scene on 5 slow targets sets them all; a target in 5xx does not stop the others', async (t) => {
  const s = await setup(t);
  s.gw.functions.push(
    ...[2, 3, 4, 5].map((n) => ({
      id: `idlight${n}`,
      type: 'OnOff',
      label: `Light ${n}`,
      datapoints: [
        { id: `idlight${n}-001`, type: 'switch', values: [{ key: 'switch', value: '0' }] },
      ],
    })),
  );
  await s.advance(300_000);
  await waitFor(() => s.app.functions.has('idlight5'), 'the new lights read');
  s.gw.latency = (r) =>
    r.path.includes('idlight') ? 500 + 100 * Number(r.path.match(/idlight(\d)/)[1]) : 0;
  const ids = [1, 2, 3, 4, 5].map((n) => `idlight${n}`);
  let acks = await Promise.all(ids.map((f) => s.fire(f, 'on', 1)));
  for (const ack of acks) assert.equal(ack.success, true, ackError(ack));
  for (const f of ids) assert.equal(s.gw.value(`${f}-001`, 'switch'), '1', f);
  acks = await Promise.all(ids.map((f) => s.fire(f, 'on', 0)));
  for (const ack of acks) assert.equal(ack.success, true, ackError(ack));
  for (const f of ids) assert.equal(s.gw.value(`${f}-001`, 'switch'), '0', f);
  s.gw.replyFor = (r) =>
    r.path.includes('idlight3') && r.method === 'PATCH' ? { status: 503, body: {} } : undefined;
  acks = await Promise.all(ids.map((f) => s.fire(f, 'on', 1)));
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true, false, true, true],
  );
  assert.match(ackError(acks[2]), /without confirmation|sans confirmation/);
});

test('outcomes: refused with the reason, not sent, sent without confirmation, too late', async (t) => {
  const s = await setup(t);
  s.gw.replyFor = (r) =>
    r.method === 'PATCH' ? { status: 423, body: { error: 'Device is locked' } } : undefined;
  let ack = await s.fire('iddim1', 'brightness', 50);
  assert.match(
    ackError(ack),
    /Refused by the gateway: Device is locked|Refusée par la passerelle : Device is locked/,
  );
  s.gw.replyFor = () => undefined;
  // Sent, no answer: never a success nor a refusal.
  s.gw.silent = (r) => r.method === 'PATCH';
  ack = await s.fire('iddim1', 'brightness', 60);
  assert.match(ackError(ack), /without confirmation|sans confirmation/);
  s.gw.silent = () => false;
  // Behind a slow command of the same target past 3.5 s (virtual): never sent.
  s.gw.latency = (r) => (r.method === 'PATCH' ? 700 : 0);
  const slow = s.fire('iddim1', 'brightness', 70);
  await waitFor(() => s.gw.sets('iddim1-002').length === 3, 'the slow one left');
  const late = s.fire('iddim1', 'brightness', 80);
  await pause(20);
  await s.advance(4000);
  ack = await late;
  assert.match(ackError(ack), /in time|à temps/);
  await slow;
  assert.equal(s.gw.sets('iddim1-002').length, 3);
  // Gateway down: nothing sent.
  s.gw.latency = () => 0;
  await s.gw.close();
  ack = await s.fire('iddim1', 'brightness', 90);
  assert.match(ackError(ack), /Nothing sent|Rien envoyé/);
});

test('a value read back equal to the one before is "not applied yet", never a success', async (t) => {
  const s = await setup(t);
  s.gw.applySets = false;
  const ack = await s.fire('iddim1', 'brightness', 80);
  assert.match(ackError(ack), /not applied yet|pas encore appliquée/);
  await s.app.publishAllTransports();
  assert.ok(
    s.fake.transports.some((b) => b.degraded),
    'the badge says it',
  );
});

test('the token is never in a log, a status, /data nor an ack', async (t) => {
  const s = await setup(t);
  await s.app.testConnection();
  await s.fire('idlight1', 'on', 0);
  s.gw.token = OTHER_TOKEN;
  await s.advance(300_000);
  await waitFor(() => s.app.blocked, 'refused');
  const everything = JSON.stringify([
    s.logs,
    s.fake.connectionStatuses,
    s.store.data,
    s.fake.requests,
  ]);
  assert.ok(!everything.includes(TOKEN));
  assert.ok(!everything.includes(TOKEN.split('.')[2]));
});

test('before the first read after a restart, a stop leaves from the device params; nothing else', async (t) => {
  const s = await setup(t);
  const known = s.fake.devices.length;
  assert.ok(known > 5, 'devices created');
  // Restart: the function list is not known until the first read (1 min away).
  s.app.stop();
  s.app.functions = new Map();
  s.app.memoryState = 'unloaded';
  await within(s.app.start(s.raw), 'restart');
  assert.ok(
    [...s.app.model.writers.keys()].every((k) => k.includes(':scene:')),
    'no function known',
  );
  for (const f of ['idlight1', 'iddim1']) s.gw.setValue(`${f}-001`, 'switch', 1, { push: false });
  const reads = s.gw.count('GET /functions/');
  let ack = await s.fire('idlight1', 'on', 0);
  assert.equal(ack.success, true, ackError(ack));
  ack = await s.fire('iddim1', 'brightness', 0);
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.gw.value('idlight1-001', 'switch'), '0');
  assert.equal(s.gw.value('iddim1-001', 'switch'), '0');
  ack = await s.fire('idblind1', 'state', 0);
  assert.equal(ack.success, true, ackError(ack));
  assert.deepEqual(s.gw.sets('idblind1-001').at(-1).json.data, [{ key: 'level_move', value: '0' }]);
  ack = await s.fire('idrtr1', 'frost', 1);
  assert.equal(ack.success, true, ackError(ack));
  const before = s.gw.requests.length;
  ack = await s.fire('idlight1', 'on', 1);
  assert.equal(ack.success, false, 'not a stop: refused until the list is read');
  ack = await s.fire('idblind1', 'state', 1);
  assert.equal(ack.success, false);
  await pause(30);
  assert.equal(s.gw.requests.filter((r, i) => i >= before && r.method === 'PATCH').length, 0);
  assert.equal(s.gw.count('GET /functions/'), reads, 'still no read');
});

test('a socket removed from the safe list while its command waits: refused right before the first byte', async (t) => {
  const s = await setup(t, { config: { safe_sockets: 'idsock2' } });
  s.gw.latency = (r) => (r.method === 'PATCH' && r.path.includes('idsock2') ? 600 : 0);
  const first = s.fire('idsock2', 'on', 1);
  await waitFor(() => s.gw.sets('idsock2-001').length === 1, 'the first left');
  const second = s.fire('idsock2', 'on', 1);
  await pause(20);
  s.app.config = { ...s.app.config, safeSockets: new Set() };
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.success, true, ackError(a));
  assert.match(ackError(b), /not declared safe|pas déclarée sûre/);
  assert.equal(s.gw.sets('idsock2-001').length, 1);
});

test('a read started before a stop never counts as its read back', async (t) => {
  const s = await setup(t);
  s.gw.setValue(PATCH_LIGHT, 'switch', 1, { push: false });
  let stale;
  s.gw.replyFor = (r) =>
    r.method === 'GET' && r.path === '/functions/' && stale
      ? { status: 200, body: stale }
      : undefined;
  s.gw.latency = (r) => {
    if (r.method === 'GET' && r.path === '/functions/') {
      stale = JSON.parse(JSON.stringify(s.gw.functions));
      return 400;
    }
    // The read back of the stop comes late: the stale read lands first.
    if (r.method === 'GET' && r.path.endsWith(PATCH_LIGHT)) return 900;
    return 0;
  };
  await s.advance(300_000);
  await waitFor(() => s.app.reading, 'the read in flight');
  const ack = s.fire('idlight1', 'on', 0);
  await waitFor(() => !s.app.reading, 'the stale read done');
  await ack;
  await waitFor(() => s.app.guards.size === 0, 'applied on its own read back');
  assert.equal(s.gw.sets(PATCH_LIGHT).length, 1, 'never sent again on the stale read');
});

test('a command sent before a stop and answered after it never lifts it', async (t) => {
  const s = await setup(t);
  s.gw.latency = (r) => {
    if (r.method === 'PATCH' && r.json?.data?.[0]?.value === '1') return 600;
    if (r.method === 'GET' && r.path.endsWith(PATCH_LIGHT)) return 1200;
    return 0;
  };
  const on = s.fire('idlight1', 'on', 1);
  await waitFor(() => s.gw.sets(PATCH_LIGHT).length === 1, 'the "on" left');
  const off = await s.fire('idlight1', 'on', 0);
  assert.equal(off.success, true, ackError(off));
  await on;
  // The "on" landed after the stop: the read back shows it, the stop goes again.
  for (let i = 0; i < 40 && s.gw.value(PATCH_LIGHT, 'switch') !== '0'; i += 1) {
    await s.advance(1000);
    await pause(40);
  }
  assert.equal(s.gw.value(PATCH_LIGHT, 'switch'), '0', 'the stop wins');
});

test('a newer command taken by the gateway lifts a stop still being resent', async (t) => {
  const s = await setup(t);
  s.gw.setValue(PATCH_LIGHT, 'switch', 1, { push: false });
  s.gw.drop = (r) => r.method === 'PATCH' && r.json?.data?.[0]?.value === '0';
  const off = s.fire('idlight1', 'on', 0);
  await pause(50);
  await s.advance(3500);
  await off;
  await waitFor(async () => {
    await s.advance(100);
    return !s.app.guardOf('idlight1')?.inFlight;
  }, 'idle');
  const ack = await s.fire('idlight1', 'on', 1);
  assert.equal(ack.success, true, ackError(ack));
  assert.equal(s.app.guards.size, 0, 'lifted');
  const offs = () => s.gw.sets(PATCH_LIGHT).filter((r) => r.json.data[0].value === '0').length;
  const before = offs();
  for (let i = 0; i < 6; i += 1) {
    await s.advance(5000);
    await pause(20);
  }
  assert.equal(offs(), before, 'never sent again');
});

test('checked again right before the first byte: option, identity, deadline (after a wait for a slot)', async (t) => {
  const s = await setup(t, { config: { allow_heating_setpoints: true } });
  const waitSlot = async (change) => {
    s.app.slotsUsed = 6;
    const ack = s.fire('idrtr1', 'setpoint', 20);
    await waitFor(() => s.app.slotWaiters.length === 1, 'waiting for a slot');
    change();
    s.app.release();
    return ack;
  };
  const before = s.gw.sets('idrtr1-001').length;
  let ack = await waitSlot(() => {
    s.app.config = { ...s.app.config, allowHeating: false };
  });
  assert.match(ackError(ack), /Heating setpoints are not allowed|consignes de chauffage/);
  s.app.config = { ...s.app.config, allowHeating: true };
  ack = await waitSlot(() => {
    s.app.identity = { ...s.app.identity, mismatch: 'snOTHER' };
  });
  assert.match(ackError(ack), /Another gateway|Une autre passerelle/);
  s.app.identity = { ...s.app.identity, mismatch: undefined };
  const mono = s.app.mono;
  ack = await waitSlot(() => {
    // 4 s pass while the slot comes back (the clock read right before the first byte).
    s.app.mono = () => mono() + 4000;
  });
  s.app.mono = mono;
  assert.match(ackError(ack), /in time|à temps/);
  assert.equal(s.gw.sets('idrtr1-001').length, before, 'nothing sent');
  s.app.slotsUsed = 0;
});

test('a cover close is never sent again on a read: the cover may have been moved since', async (t) => {
  const s = await setup(t);
  s.gw.latency = (r) => (r.method === 'GET' && r.path.endsWith('idblind1-001') ? 500 : 0);
  const ack = await s.fire('idblind1', 'state', -1);
  assert.equal(ack.success, true, ackError(ack));
  // Moved from the wall right after.
  s.gw.setValue('idblind1-001', 'level', 50);
  await pause(700);
  for (let i = 0; i < 6; i += 1) {
    await s.advance(5000);
    await pause(20);
  }
  assert.equal(s.gw.sets('idblind1-001').length, 1);
  assert.equal(s.gw.value('idblind1-001', 'level'), '50');
});
