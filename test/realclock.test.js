// -----------------------------------------------------------------------------
// The real clock, 20 times faster, against the simulated gateway: the period
// of the reads and of the work on a kept stop, measured (wide margins: a
// timer is late under load, never early). The app is stopped in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { JungHomeApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { TOKEN, fakeGateway } from './helpers/fakeGateway.js';
import { waitFor, within } from './helpers/setup.js';

async function start(t, config) {
  const gw = await fakeGateway();
  t.after(() => gw.close());
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const raw = {
    gateway_address: gw.address,
    api_token: TOKEN,
    live_updates: false,
    poll_interval: 30,
    ...config,
  };
  const gladys = createFakeGladys({ config: raw });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new JungHomeApp({
    gladys,
    logger,
    store: memoryStore({ pins: { [gw.address]: gw.fingerprint } }),
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  return { gw, clock, gladys, app };
}

test('real clock x20: the reads come at the interval (30 s), measured', async (t) => {
  const { clock, gladys, app } = await start(t);
  const spy = spyOn(app, 'tick', clock);
  t.after(() => spy.restore());
  await within(gladys.connect(), 'connect');
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
});

test('real clock x20: a stop that does not land is worked on every 5 s, measured, then lands', async (t) => {
  const { gw, clock, gladys, app } = await start(t);
  await within(gladys.connect(), 'connect');
  await waitFor(() => app.online, 'online', 6000);
  gw.setValue('idlight1-001', 'switch', 1, { push: false });
  let down = true;
  gw.drop = (r) => down && r.method === 'PATCH';
  const spy = spyOn(app, 'workGuard', clock);
  t.after(() => spy.restore());
  const device = { external_id: 'ext:test-integration:function:snJH0012345678_idlight1' };
  const ack = gladys.fake.setValue(device, { external_id: `${device.external_id}:on` }, 0);
  const gaps = await measurePeriod(spy, { count: 3, period: 5000 });
  assert.equal(gaps.length, 2);
  assert.equal((await within(ack, 'ack')).success, false);
  down = false;
  await waitFor(() => gw.value('idlight1-001', 'switch') === '0', 'landed', 6000);
  await waitFor(() => app.guards.size === 0, 'applied', 6000);
});
