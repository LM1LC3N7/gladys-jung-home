// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the simulated gateway
// (test/helpers/fakeGateway.js), with the exact wiring of the container
// (src/handlers.js). The app's timers are virtual (the kit's testClock: they
// fire only on `advance`), the network is real (127.0.0.1): every wait on the
// network is bounded in real time, so a test fails, it never hangs.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { JungHomeApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { testClock } from '../kit/clock.mjs';
import { TOKEN, fakeGateway } from './fakeGateway.js';

export const GATEWAY = 'snJH0012345678';
export const device = (fid) => `ext:test-integration:function:${GATEWAY}_${fid}`;
export const feature = (fid, key) => `${device(fid)}:${key}`;
export const sceneFeature = (id) => `ext:test-integration:scene:${GATEWAY}_${id}:recall`;

/** Real-time wait for a condition, bounded: throws (never hangs) after `timeout` ms. */
export async function waitFor(fn, what = 'the condition', timeout = 4000) {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A promise bounded in real time: rejects (never hangs) after `timeout` ms. */
export function within(promise, what = 'the promise', timeout = 6000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} never settled`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setup(
  t,
  {
    gateway = {},
    config = {},
    memory,
    store,
    pinned = true,
    connect = true,
    create = true,
    getConfig,
  } = {},
) {
  const gw = await fakeGateway(gateway);
  t.after(() => gw.close());
  const clock = testClock();
  const kept =
    store ??
    memoryStore(
      memory === undefined ? (pinned ? { pins: { [gw.address]: gw.fingerprint } } : null) : memory,
    );
  const raw = { gateway_address: gw.address, api_token: TOKEN, ...config };
  const gladys = createFakeGladys({ config: raw });
  if (getConfig) gladys.getConfig = getConfig;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new JungHomeApp({
    gladys,
    logger,
    store: kept,
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  // The shutdown waits for /data at most 2 s (virtual): moved on by hand.
  t.after(async () => {
    const done = app.shutdown();
    await clock.advance(2000);
    await within(done, 'the shutdown');
  });
  const fake = gladys.fake;
  const status = () => fake.connectionStatus;
  const message = () => status()?.message?.en ?? '';
  const advance = (ms) => clock.advance(ms);
  // Polls in real time, firing the virtual timers already due at each turn.
  const online = () =>
    waitFor(async () => {
      await clock.advance(0);
      return app.online;
    }, 'the gateway read');
  const ctx = {
    gw,
    gladys,
    fake,
    app,
    clock,
    store: kept,
    logs,
    raw,
    status,
    message,
    advance,
    online,
  };

  /** Sends the pending states to Gladys (the publisher runs every second). */
  ctx.flush = async () => {
    await advance(1000);
    await within(app.publisher.flush(), 'the publication');
  };
  ctx.lastState = (fid, key) => fake.lastState(feature(fid, key));
  ctx.fire = (fid, key, value) => {
    const d = fake.devices.find((x) => x.external_id === device(fid)) ?? {
      external_id: device(fid),
    };
    return within(
      fake.setValue(d, { external_id: feature(fid, key) }, value),
      `the ack of ${fid}:${key}`,
    );
  };
  ctx.fireScene = (id) =>
    within(
      fake.setValue(
        { external_id: sceneFeature(id).replace(/:recall$/, '') },
        { external_id: sceneFeature(id) },
        1,
      ),
      'the scene ack',
    );
  ctx.createAll = async () => {
    for (const d of fake.discoveredDevices) await within(fake.deviceCreated(d), 'deviceCreated');
  };

  if (connect) {
    await within(gladys.connect(), 'the connection to Gladys');
    await advance(0);
    await online();
    if (create) {
      await ctx.createAll();
      await ctx.flush();
    }
  }
  return ctx;
}
