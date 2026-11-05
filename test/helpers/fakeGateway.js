// -----------------------------------------------------------------------------
// A simulated JUNG HOME gateway on 127.0.0.1, built from docs/gateway-rest-api.md
// and docs/gateway-websocket.md of the junghome reference (MIT): HTTPS with a
// self-signed certificate (the kit's), the REST API under /api/junghome with
// the `token` header, and the WebSocket /ws (snapshot on connect, a datapoint
// frame for each change). Latency, refusals, silences and 429 on demand;
// every request recorded.
// -----------------------------------------------------------------------------

import { createServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { certs } from '../kit/certs.mjs';

export const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiMDBhYmNkZWYifQ.c2lnbmF0dXJlLW9mLXRlc3Q';
export const OTHER_TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiMTFhYmNkZWYifQ.b3RoZXItc2lnbmF0dXJl';

const dp = (id, type, values) => ({
  id,
  type,
  values: Object.entries(values).map(([key, value]) => ({ key, value: String(value) })),
});

/** The installation of the tests (the reference fixture, with real-looking ids). */
export function fixtureFunctions() {
  return [
    {
      id: 'idlight1',
      type: 'OnOff',
      label: 'Hall Light',
      datapoints: [dp('idlight1-001', 'switch', { switch: 0 })],
    },
    {
      id: 'iddim1',
      type: 'DimmerLight',
      label: 'Dimmer',
      datapoints: [
        dp('iddim1-001', 'switch', { switch: 0 }),
        dp('iddim1-002', 'brightness', { brightness: 30 }),
      ],
    },
    {
      id: 'idblind1',
      type: 'PositionAndAngle',
      label: 'Bedroom Blind',
      datapoints: [
        dp('idblind1-001', 'level', { level: 30 }),
        dp('idblind1-002', 'angle', { angle: 40 }),
      ],
    },
    {
      id: 'idrtr1',
      type: 'Thermostat',
      label: 'Living Room',
      datapoints: [
        dp('idrtr1-000', 'switch', { switch: 1 }),
        dp('idrtr1-001', 'temperature_ctrl', {
          temperature_ctrl: '21.5',
          temperature_ctrl_preset: 'comfort',
        }),
        dp('idrtr1-010', 'quantity', {
          quantity: '20.0',
          quantity_label: 'Present Ambient Temperature ',
          quantity_unit: '°C',
        }),
      ],
    },
    {
      id: 'idsock1',
      type: 'Socket',
      label: 'Boiler',
      datapoints: [
        dp('idsock1-001', 'switch', { switch: 1 }),
        dp('idsock1-010', 'quantity', {
          quantity: '5',
          quantity_label: 'Present Device Input Power ',
          quantity_unit: 'W',
        }),
      ],
    },
    {
      id: 'idsock2',
      type: 'Socket',
      label: 'Lamp socket',
      datapoints: [dp('idsock2-001', 'switch', { switch: 0 })],
    },
    {
      id: 'idmeas1',
      type: 'Measurement',
      label: 'Hallway Sensor',
      datapoints: [
        dp('idmeas1-010', 'quantity', {
          quantity: '120',
          quantity_label: 'Present Illuminance ',
          quantity_unit: 'lux',
        }),
      ],
    },
    {
      id: 'idrock1',
      type: 'RockerSwitch',
      label: 'Button A',
      datapoints: [
        dp('idrock1-00c', 'up_request', { up_request: 0 }),
        dp('idrock1-00d', 'down_request', { down_request: 0 }),
        dp('idrock1-00e', 'status_led', { status_led: 0 }),
      ],
    },
  ];
}

export const fixtureScenes = () => [
  { id: 'id0001', label: 'Kitchen off', related_functions: ['idlight1'], value: '0001' },
  { id: 'id0002', label: 'Evening', related_functions: [], value: '0002' },
];

/**
 * Options (all changeable on the returned object):
 * - latency(request) -> ms before the answer (default 0);
 * - silent(request) -> true: never answers;
 * - replyFor(request) -> { status, body } to answer instead of the normal one;
 * - applySets: false -> a PATCH is answered 200 but not applied;
 * - serial ('' until set), mac, token, wsToken (accepted on the socket);
 * - cert: the kit's device certificate (or another one).
 */
export async function fakeGateway(options = {}) {
  const gw = {
    functions: fixtureFunctions(),
    scenes: fixtureScenes(),
    serial: 'JH0012345678',
    mac: '00:11:22:33:44:55',
    token: TOKEN,
    latency: () => 0,
    silent: () => false,
    replyFor: () => undefined,
    applySets: true,
    snapshotDelay: 0,
    registerAnswer: undefined,
    requests: [],
    wsConnections: 0,
    wsClients: new Set(),
    port: 0,
    ...options,
  };
  const cert = options.cert ?? certs.device;
  const findDp = (fid, dpid) =>
    gw.functions.find((f) => f.id === fid)?.datapoints.find((d) => d.id === dpid);
  gw.findDp = findDp;
  gw.value = (dpid, key) => {
    const fid = dpid.slice(0, dpid.lastIndexOf('-'));
    return findDp(fid, dpid)?.values.find((v) => v.key === key)?.value;
  };
  gw.setValue = (dpid, key, value, { push = true } = {}) => {
    const fid = dpid.slice(0, dpid.lastIndexOf('-'));
    const d = findDp(fid, dpid);
    const v = d.values.find((x) => x.key === key);
    if (v) v.value = String(value);
    else d.values.push({ key, value: String(value) });
    if (push) gw.broadcast({ type: 'datapoint', data: d });
  };
  gw.broadcast = (frame) => {
    for (const ws of gw.wsClients) ws.send(JSON.stringify(frame));
  };
  gw.count = (match) =>
    gw.requests.filter((r) =>
      match instanceof RegExp
        ? match.test(`${r.method} ${r.path}`)
        : `${r.method} ${r.path}` === match,
    ).length;
  gw.sets = (dpid) =>
    gw.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith(`/${dpid}`));

  const send = (res, status, body, headers = {}) => {
    if (res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      ...headers,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  const handle = async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'https://gateway');
    const path = url.pathname.replace(/^\/api\/junghome/, '');
    let json;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const request = {
      method: req.method,
      path,
      token: req.headers.token,
      json,
      at: performance.now(),
      url: req.url,
    };
    gw.requests.push(request);
    const delay = gw.latency(request);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (gw.silent(request)) return;
    if (gw.drop?.(request)) return req.socket.destroy();
    const forced = gw.replyFor(request);
    if (forced) return send(res, forced.status, forced.body ?? {}, forced.headers);
    if (path === '/version/')
      return send(res, 200, {
        api_version: '1.5.0',
        version_release: '2.1.3',
        version_build: '2840',
      });
    if (req.method === 'POST' && path === '/register') {
      const answer = await (gw.registerAnswer?.(request) ?? {
        status: 400,
        body: { error: 'Error during register.' },
      });
      return send(res, answer.status, answer.body);
    }
    if (req.headers.token !== gw.token) return send(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && path === '/functions/') return send(res, 200, gw.functions);
    if (req.method === 'GET' && path === '/scenes/') return send(res, 200, gw.scenes);
    if (req.method === 'POST' && /^\/scenes\/id\w+$/.test(path))
      return send(res, 200, { message: 'OK' });
    if (path === '/config/parameter/system_serial') {
      return gw.serial === null
        ? send(res, 404, { error: 'not found' })
        : send(res, 200, gw.serial);
    }
    if (path === '/config/parameter/ip_mac') return send(res, 200, gw.mac);
    const m = /^\/functions\/(id\w+)\/datapoints\/(id\w+-[0-9a-f]{3})$/.exec(path);
    if (m) {
      const d = findDp(m[1], m[2]);
      if (!d) return send(res, 404, { error: `Datapoint with id '${m[2]}' not found` });
      if (req.method === 'GET') return send(res, 200, d);
      if (req.method === 'PATCH') {
        if (!Array.isArray(json?.data))
          return send(res, 400, { error: 'Wrong format of payload! Expected array.' });
        if (gw.applySets) {
          for (const { key, value } of json.data) {
            gw.setValue(d.id, key, value, { push: false });
            // A frost preset sets the target temperature (the preset is derived from it).
            if (key === 'temperature_ctrl_preset' && value === 'frost')
              gw.setValue(d.id, 'temperature_ctrl', '7.0', { push: false });
          }
          gw.broadcast({ type: 'datapoint', data: d });
        }
        return send(res, 200, { message: 'OK' });
      }
    }
    return send(res, 404, { error: 'not found' });
  };

  const server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    res.on('error', () => {});
    handle(req, res).catch(() => res.destroy());
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    gw.requests.push({
      method: 'UPGRADE',
      path: req.url,
      token: req.headers.token,
      at: performance.now(),
    });
    if (req.url !== '/ws' || req.headers.token !== (gw.wsToken ?? gw.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      gw.wsConnections += 1;
      gw.wsClients.add(ws);
      ws.on('close', () => gw.wsClients.delete(ws));
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'message', data: 'Hello from JUNG HOME Gateway' }));
      ws.send(JSON.stringify({ type: 'version', data: '1.5.0' }));
      setTimeout(() => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ type: 'functions', data: gw.functions }));
        ws.send(JSON.stringify({ type: 'groups', data: [] }));
        ws.send(JSON.stringify({ type: 'scenes', data: gw.scenes }));
      }, gw.snapshotDelay);
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(gw.port, '127.0.0.1', resolve));
  gw.port = server.address().port;
  gw.address = `127.0.0.1:${gw.port}`;
  gw.fingerprint = cert.fingerprint256;
  gw.close = async () => {
    for (const ws of gw.wsClients) ws.terminate();
    wss.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return gw;
}
