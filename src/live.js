// -----------------------------------------------------------------------------
// The live socket of the gateway: wss://<gateway>/ws, opened with the same
// `token` header as the REST API, on a pinned TLS connection (src/gateway.js):
// the certificate is checked before the upgrade request is written.
//
// Frames (docs/gateway-websocket.md of the junghome reference): on connect,
// `functions` (the full list, as GET /functions/), `groups`, `scenes`; then a
// `datapoint` frame for each change, `scene` when a scene is recalled,
// `functions` again when the installation changes. Frames are bounded in size
// (`maxPayload`, checked by ws before the frame is complete); only known keys
// are copied.
// -----------------------------------------------------------------------------

import WebSocket from 'ws';
import { LIMITS, TIMINGS, WS_PATH } from './constants.js';
import { GatewayError, connectPinned } from './gateway.js';

/** One frame -> `{ type, ... }` with only what the integration uses, or undefined. */
export function frameOf(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const { type, data } = json;
  if (type === 'functions' && Array.isArray(data)) return { type, list: data };
  if (type === 'scenes' && Array.isArray(data)) return { type, list: data };
  if (type === 'datapoint' && data && typeof data === 'object' && !Array.isArray(data)) {
    return { type, datapoint: data };
  }
  if (type === 'message' && typeof data === 'string') return { type, text: data.slice(0, 300) };
  return undefined;
}

/**
 * Opens the socket; resolves once it is open. `onFrame(frame)` gets each
 * frame understood; `onClose(reason)` is called once when an open socket is
 * lost (never after `close()`). A 401 on the upgrade is a refused token.
 * @returns {Promise<{ close(): void }>}
 */
export async function openLive({
  host,
  port,
  pin,
  token,
  timers = globalThis,
  connect = connectPinned,
  onFrame = () => {},
  onClose = () => {},
}) {
  const socket = await connect({ host, port, pin, timeout: TIMINGS.connectTimeout });
  return new Promise((resolve, reject) => {
    const shown = host.includes(':') ? `[${host}]` : host;
    let ws;
    try {
      ws = new WebSocket(`ws://${shown}:${port}${WS_PATH}`, {
        createConnection: () => socket,
        headers: { token },
        maxPayload: LIMITS.frameBytes,
        handshakeTimeout: TIMINGS.liveOpen,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch {
      socket.destroy();
      reject(new GatewayError('network', 'cannot open the socket'));
      return;
    }
    let open = false;
    let done = false;
    let pingTimer;
    let pongTimer;
    const finish = (reason, error, { notify = true } = {}) => {
      if (done) return;
      done = true;
      timers.clearInterval(pingTimer);
      timers.clearTimeout(pongTimer);
      try {
        ws.terminate();
      } catch {
        // Already closed.
      }
      socket.destroy();
      if (!open) reject(error ?? new GatewayError('network', reason));
      else if (notify) onClose(reason);
    };
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode;
      res.resume();
      finish(
        `HTTP ${status}`,
        status === 401 || status === 403
          ? new GatewayError('auth', `token refused (HTTP ${status})`, { status })
          : new GatewayError(
              status === 429 ? 'rate' : 'refused',
              `socket refused (HTTP ${status})`,
              {
                status,
              },
            ),
      );
    });
    ws.on('open', () => {
      if (done) return;
      open = true;
      // The gateway may drop a socket silently: a ping every minute, its pong expected.
      pingTimer = timers.setInterval(() => {
        try {
          ws.ping();
        } catch {
          finish('ping failed');
          return;
        }
        timers.clearTimeout(pongTimer);
        pongTimer = timers.setTimeout(() => finish('no answer to the ping'), TIMINGS.livePong);
      }, TIMINGS.livePing);
      resolve({ close: () => finish('closed', undefined, { notify: false }) });
    });
    ws.on('pong', () => timers.clearTimeout(pongTimer));
    ws.on('message', (data, isBinary) => {
      if (!open || done || isBinary) return;
      let json;
      try {
        json = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const frame = frameOf(json);
      if (frame) onFrame(frame);
    });
    ws.on('close', () => finish('connection closed'));
    // The error of ws may quote the request: never its text.
    ws.on('error', (err) =>
      finish(
        err?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'frame too large' : 'connection lost',
      ),
    );
  });
}
