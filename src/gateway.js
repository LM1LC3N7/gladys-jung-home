// -----------------------------------------------------------------------------
// The REST API of the JUNG HOME gateway (https://<gateway>/api/junghome), from
// docs/gateway-rest-api.md of the junghome reference (MIT).
//
// TLS: the gateway certificate is self-signed. Every connection is a bare TLS
// handshake first; the certificate seen is compared with the pinned SHA-256
// fingerprint BEFORE anything is written or read: a mismatch closes the
// socket, so the token never reaches another server. Then one HTTP request is
// written on that socket (`createConnection`, no agent, `Connection: close`):
// one request per connection, never a pipeline.
//
// The token goes in the `token` header, only on a verified connection. It is
// never logged nor put in an error message. Redirections are never followed.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { API_BASE, LIMITS, PATHS, TIMINGS } from './constants.js';
import { TOKEN } from './config.js';

export class GatewayError extends Error {
  /**
   * @param {'nopin'|'pin'|'auth'|'rate'|'notfound'|'refused'|'server'|'redirect'|'network'|'timeout'|'size'|'format'|'aborted'} kind
   * @param {string} message never a token
   * @param {{ status?: number, sent?: boolean, retryAfter?: number, fingerprint?: string }} details
   *   sent: the request was written (it may have been done); status: the gateway answered
   */
  constructor(kind, message, { status, sent = false, retryAfter, fingerprint } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.kind = kind;
    this.status = status;
    this.sent = sent || status !== undefined;
    this.retryAfter = retryAfter;
    this.fingerprint = fingerprint;
  }

  /** The gateway answered (any status): the request reached it. */
  get answered() {
    return this.status !== undefined;
  }
}

const NETWORK = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const networkError = (err, sent) =>
  err instanceof GatewayError
    ? err
    : new GatewayError('network', NETWORK[err?.code] ?? 'network error', { sent });

/** A short text of the gateway: no control character, nothing that looks like a token. */
export function cleanReason(text, token) {
  let out = typeof text === 'string' ? text : '';
  if (token) out = out.split(token).join('…');
  return out
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '…')
    .replace(/[^\x20-\x7e\u00a0-\u024f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Retry-After (seconds or an HTTP date) -> ms, or undefined. */
export function retryAfterOf(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * A TLS connection whose certificate is the pinned one; nothing is written nor
 * read before the check. Without a pin: refused (nothing sent).
 */
export function connectPinned({ host, port, pin, timeout = TIMINGS.connectTimeout, signal }) {
  return new Promise((resolve, reject) => {
    if (!pin) {
      reject(new GatewayError('nopin', 'certificate not pinned'));
      return;
    }
    let done = false;
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      // Self-signed: the CA check cannot pass; the pin below replaces it.
      rejectUnauthorized: false,
    });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('secureConnect', onSecure);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const onAbort = () => finish(new GatewayError('aborted', 'stopped'));
    const onSecure = () => {
      const seen = socket.getPeerCertificate()?.fingerprint256;
      if (seen !== pin) {
        finish(
          new GatewayError('pin', 'the certificate of the gateway changed', { fingerprint: seen }),
        );
        return;
      }
      finish();
    };
    const timer = setTimeout(
      () => finish(new GatewayError('timeout', 'no TLS connection within the delay')),
      timeout,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', onSecure);
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/** The fingerprint of the certificate the gateway shows (a bare handshake: nothing is sent). */
export function readFingerprint({ host, port, timeout = TIMINGS.connectTimeout }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new GatewayError('timeout', 'no TLS connection within the delay')),
      timeout,
    );
    socket.once('secureConnect', () => {
      const seen = socket.getPeerCertificate()?.fingerprint256;
      if (typeof seen === 'string' && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(seen)) {
        finish(undefined, seen);
      } else {
        finish(new GatewayError('format', 'no certificate shown'));
      }
    });
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/**
 * One request on a pinned connection; resolves { status, headers, body }.
 * `beforeSend()` runs once the certificate is checked, just before the first
 * byte of the request: it may throw to cancel (nothing sent).
 */
export async function pinnedRequest({
  host,
  port,
  pin,
  method,
  path,
  token,
  json,
  timeout = TIMINGS.readTimeout,
  idleTimeout = TIMINGS.idleTimeout,
  maxBytes = LIMITS.responseBytes,
  beforeSend,
  signal,
}) {
  const started = performance.now();
  const socket = await connectPinned({
    host,
    port,
    pin,
    timeout: Math.min(timeout, TIMINGS.connectTimeout),
    signal,
  });
  try {
    beforeSend?.();
  } catch (err) {
    socket.destroy();
    throw err;
  }
  const left = Math.max(1, timeout - (performance.now() - started));
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let idle;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      req.destroy();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => settle(new GatewayError('aborted', 'stopped', { sent }));
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => settle(new GatewayError('timeout', 'the gateway stopped answering', { sent })),
        idleTimeout,
      );
    };
    const headers = { Accept: 'application/json', Connection: 'close' };
    if (token) headers.token = token;
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    // No agent: the verified socket is the connection (never `agent: false`).
    const req = http.request({
      host,
      port,
      method,
      path: `${API_BASE}${path}`,
      headers,
      createConnection: () => socket,
    });
    req.on('response', (res) => {
      armIdle();
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(new GatewayError('size', 'answer too large', { status: res.statusCode }));
          return;
        }
        chunks.push(chunk);
        armIdle();
      });
      res.on('end', () =>
        settle(undefined, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(networkError(err, true)));
    });
    req.on('error', (err) => settle(networkError(err, sent)));
    const timer = setTimeout(
      () => settle(new GatewayError('timeout', 'no answer within the delay', { sent })),
      left,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    sent = true;
    armIdle();
    req.end(body);
  });
}

/** The JSON of an answer, or the GatewayError it is. */
export function parseAnswer({ status, headers = {}, body }, token) {
  let json;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  const reason = cleanReason(json?.error ?? json?.message, token);
  const at = { status };
  if (status >= 300 && status < 400) {
    throw new GatewayError('redirect', `redirected (HTTP ${status})`, at);
  }
  if (status === 401 || status === 403) {
    throw new GatewayError('auth', `token refused (HTTP ${status})`, at);
  }
  if (status === 429) {
    throw new GatewayError('rate', 'too many requests (HTTP 429)', {
      ...at,
      retryAfter: retryAfterOf(headers['retry-after']),
    });
  }
  if (status === 404) throw new GatewayError('notfound', reason || 'not found (HTTP 404)', at);
  if (status >= 500) throw new GatewayError('server', `HTTP ${status}`, at);
  if (status >= 400) throw new GatewayError('refused', reason || `HTTP ${status}`, at);
  if (status < 200 || status >= 300) throw new GatewayError('format', `HTTP ${status}`, at);
  if (json === undefined) throw new GatewayError('format', 'not an answer of the gateway', at);
  return json;
}

/**
 * A client of one gateway: its address, its pinned certificate and the token
 * are frozen for the client's life.
 */
export function createGateway({ host, port, pin, token, request = pinnedRequest, signal }) {
  const call = async (method, path, options = {}) => {
    const answer = await request({ host, port, pin, method, path, token, signal, ...options });
    return parseAnswer(answer, token);
  };
  return {
    host,
    port,
    pin,
    /** The API and software versions (no token needed). */
    version: (o) => call('GET', PATHS.version, { ...o, token: undefined }),
    functions: (o) => call('GET', PATHS.functions, o),
    datapoint: (fid, dpid, o) => call('GET', PATHS.datapoint(fid, dpid), o),
    scenes: (o) => call('GET', PATHS.scenes, o),
    serial: (o) => call('GET', PATHS.serial, o),
    mac: (o) => call('GET', PATHS.mac, o),
    /** Sets one value of a datapoint; the 200 carries no value (a read confirms). */
    setDatapoint: (fid, dpid, key, value, o) =>
      call('PATCH', PATHS.datapoint(fid, dpid), {
        ...o,
        json: { data: [{ key, value: String(value) }] },
      }),
    recallScene: (id, o) => call('POST', PATHS.scene(id), { ...o, json: {} }),
  };
}

/**
 * Asks the gateway for a token: the request waits (up to 180 s) for the user
 * to approve "Gladys" in the JUNG HOME app (Settings, Gateway, Access
 * permissions, Open requests). One request per click, never repeated.
 * @returns {Promise<string>} the token (never log it)
 */
export async function register({ host, port, pin, name, request = pinnedRequest, signal }) {
  const answer = await request({
    host,
    port,
    pin,
    method: 'POST',
    path: PATHS.register,
    json: { user_name: name },
    timeout: TIMINGS.registerTimeout,
    idleTimeout: TIMINGS.registerTimeout,
    maxBytes: 16 * 1024,
    signal,
  });
  const json = parseAnswer(answer);
  const token = typeof json?.token === 'string' ? json.token.trim() : '';
  if (!TOKEN.test(token)) throw new GatewayError('format', 'the gateway answered without a token');
  return token;
}
