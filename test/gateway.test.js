import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTls } from 'node:tls';
import { createServer as createHttps } from 'node:https';
import {
  GatewayError,
  cleanReason,
  createGateway,
  parseAnswer,
  pinnedRequest,
  readFingerprint,
  register,
} from '../src/gateway.js';
import { openLive } from '../src/live.js';
import { certs } from './kit/certs.mjs';
import { TOKEN, fakeGateway } from './helpers/fakeGateway.js';
import { waitFor } from './helpers/setup.js';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** A TLS server with another certificate that records every byte it receives. */
async function impostor(t) {
  const imp = { received: Buffer.alloc(0), connections: 0 };
  const server = createTls({ key: certs.impostor.key, cert: certs.impostor.cert }, (socket) => {
    socket.on('data', (c) => (imp.received = Buffer.concat([imp.received, c])));
    socket.on('error', () => {});
    // A forged answer written at once, before any request.
    socket.write(
      'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n[]',
    );
  });
  server.on('tlsClientError', () => {});
  server.on('connection', () => (imp.connections += 1));
  imp.port = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));
  return imp;
}

test('a certificate other than the pinned one: refused before any byte, the token never sent', async (t) => {
  const imp = await impostor(t);
  const client = createGateway({
    host: '127.0.0.1',
    port: imp.port,
    pin: certs.device.fingerprint256,
    token: TOKEN,
  });
  for (const call of [
    () => client.functions(),
    () => client.setDatapoint('ida', 'ida-001', 'switch', 0),
  ]) {
    const err = await call().catch((e) => e);
    assert.equal(err.kind, 'pin');
    assert.equal(err.fingerprint, certs.impostor.fingerprint256, 'the fingerprint seen is shown');
    assert.equal(err.sent, false);
  }
  await assert.rejects(
    openLive({ host: '127.0.0.1', port: imp.port, pin: certs.device.fingerprint256, token: TOKEN }),
    (e) => e.kind === 'pin',
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(imp.connections >= 1);
  assert.ok(
    !imp.received.toString('latin1').includes(TOKEN),
    'the token never reached the impostor',
  );
  assert.ok(!imp.received.toString('latin1').includes('HTTP/1.1'), 'no request at all');
});

test('no pin: nothing is sent', async (t) => {
  const imp = await impostor(t);
  const err = await createGateway({
    host: '127.0.0.1',
    port: imp.port,
    pin: undefined,
    token: TOKEN,
  })
    .functions()
    .catch((e) => e);
  assert.equal(err.kind, 'nopin');
  assert.equal(imp.connections, 0);
});

test('readFingerprint: a bare handshake, nothing written', async (t) => {
  const imp = await impostor(t);
  assert.equal(
    await readFingerprint({ host: '127.0.0.1', port: imp.port }),
    certs.impostor.fingerprint256,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(imp.received.length, 0);
});

test('the pinned gateway: token in the header, beforeSend just before the first byte, can cancel', async (t) => {
  const gw = await fakeGateway();
  t.after(() => gw.close());
  const client = createGateway({
    host: '127.0.0.1',
    port: gw.port,
    pin: gw.fingerprint,
    token: TOKEN,
  });
  assert.equal((await client.functions()).length, gw.functions.length);
  assert.equal(gw.requests.at(-1).token, TOKEN);
  let called = 0;
  await client.setDatapoint('idlight1', 'idlight1-001', 'switch', 1, {
    beforeSend: () => (called += 1),
  });
  assert.equal(called, 1);
  assert.equal(gw.value('idlight1-001', 'switch'), '1');
  const before = gw.requests.length;
  const err = await client
    .setDatapoint('idlight1', 'idlight1-001', 'switch', 0, {
      beforeSend: () => {
        throw new Error('cancelled');
      },
    })
    .catch((e) => e);
  assert.equal(err.message, 'cancelled');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(gw.requests.length, before, 'nothing sent');
  // version needs no token, and none is sent.
  await client.version();
  assert.equal(gw.requests.at(-1).token, undefined);
});

test('answers: oversized cut before the end, silence bounded, redirect not followed', async (t) => {
  let mode = 'big';
  const server = createHttps({ key: certs.device.key, cert: certs.device.cert }, (req, res) => {
    if (mode === 'big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let n = 0;
      const pump = () => {
        while (n < 100 && res.write(chunk)) n += 1;
        if (n < 100) res.once('drain', pump);
        else res.end('[]');
      };
      pump();
    } else if (mode === 'silent') {
      res.writeHead(200);
      res.write('[');
    } else {
      res.writeHead(302, { location: 'https://elsewhere/' });
      res.end();
    }
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const base = {
    host: '127.0.0.1',
    port,
    pin: certs.device.fingerprint256,
    method: 'GET',
    path: '/functions/',
  };
  await assert.rejects(pinnedRequest(base), (e) => e.kind === 'size');
  mode = 'silent';
  const t0 = performance.now();
  await assert.rejects(
    pinnedRequest({ ...base, idleTimeout: 200 }),
    (e) => e.kind === 'timeout' && e.sent,
  );
  assert.ok(performance.now() - t0 < 2000);
  mode = 'redirect';
  await assert.rejects(
    createGateway({ ...base, token: TOKEN }).functions(),
    (e) => e.kind === 'redirect',
  );
});

test('parseAnswer: statuses mapped; reasons cleaned; never the token', () => {
  const a = (status, body, headers) => {
    try {
      return parseAnswer({ status, body: JSON.stringify(body), headers }, TOKEN);
    } catch (e) {
      return e;
    }
  };
  assert.deepEqual(a(200, [1]), [1]);
  assert.equal(a(401, {}).kind, 'auth');
  assert.equal(a(403, {}).kind, 'auth');
  assert.equal(a(429, {}, { 'retry-after': '120' }).retryAfter, 120_000);
  assert.equal(a(404, {}).kind, 'notfound');
  const locked = a(423, { error: `Device is locked ${TOKEN}` });
  assert.equal(locked.kind, 'refused');
  assert.ok(!locked.message.includes(TOKEN));
  assert.equal(
    a(409, { error: 'Conflict with newer request' }).message,
    'Conflict with newer request',
  );
  assert.equal(a(503, {}).kind, 'server');
  assert.equal(parseAnswer.length, 2);
  assert.ok(new GatewayError('server', 'x', { status: 503 }).answered);
  assert.equal(cleanReason('a\u0000b\r\nc'), 'a b c');
  assert.equal(cleanReason('x'.repeat(300)).length, 120);
  const notJson = (() => {
    try {
      return parseAnswer({ status: 200, body: '<html>' });
    } catch (e) {
      return e;
    }
  })();
  assert.equal(notJson.kind, 'format');
});

test('register: one request with user_name "Gladys", the token checked', async (t) => {
  const gw = await fakeGateway({
    registerAnswer: (r) =>
      r.json?.user_name === 'Gladys'
        ? { status: 200, body: { token: TOKEN } }
        : { status: 400, body: {} },
  });
  t.after(() => gw.close());
  const base = { host: '127.0.0.1', port: gw.port, pin: gw.fingerprint, name: 'Gladys' };
  assert.equal(await register(base), TOKEN);
  assert.equal(gw.count('POST /register'), 1);
  gw.registerAnswer = () => ({ status: 200, body: { token: 'not\r\na token' } });
  await assert.rejects(register(base), (e) => e.kind === 'format');
  gw.registerAnswer = () => ({ status: 400, body: { error: 'Error during register.' } });
  await assert.rejects(register(base), (e) => e.kind === 'refused');
});

test('live: snapshot then datapoint frames; a 401 on the upgrade is a refused token; big frames cut', async (t) => {
  const gw = await fakeGateway();
  t.after(() => gw.close());
  const frames = [];
  const session = await openLive({
    host: '127.0.0.1',
    port: gw.port,
    pin: gw.fingerprint,
    token: TOKEN,
    onFrame: (f) => frames.push(f),
  });
  t.after(() => session.close());
  await waitFor(() => frames.some((f) => f.type === 'functions'), 'the snapshot');
  gw.setValue('idlight1-001', 'switch', 1);
  await waitFor(() => frames.some((f) => f.type === 'datapoint'), 'a datapoint frame');
  let closed;
  const second = await openLive({
    host: '127.0.0.1',
    port: gw.port,
    pin: gw.fingerprint,
    token: TOKEN,
    onClose: (r) => (closed = r),
  });
  t.after(() => second.close());
  gw.broadcast({ type: 'datapoint', data: { id: 'idlight1-001', pad: 'x'.repeat(1100 * 1024) } });
  await waitFor(() => closed, 'the socket closed on a frame too large');
  await assert.rejects(
    openLive({
      host: '127.0.0.1',
      port: gw.port,
      pin: gw.fingerprint,
      token: 'eyJhbGc.eyJ1c2Vy.wrong',
    }),
    (e) => e.kind === 'auth',
  );
});
