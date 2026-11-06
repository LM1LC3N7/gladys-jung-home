// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized. Nothing here
// talks to the network.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LANGUAGES, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  gateway_address: '',
  certificate_fingerprint: '',
  live_updates: true,
  poll_interval: POLL_INTERVAL.default,
  safe_sockets: '',
  allow_scenes: false,
  allow_heating_setpoints: false,
  language: 'fr',
};

/** A function id of the gateway: "id" + letters and digits (never ".", ":" nor "/"). */
export const FUNCTION_ID = /^id[A-Za-z0-9]{1,40}$/;
/** A JWT of the gateway (three base64url parts). */
export const TOKEN = /^[A-Za-z0-9_-]{4,2000}\.[A-Za-z0-9_-]{4,2000}\.[A-Za-z0-9_-]{0,2000}$/;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * The gateway address from what the user typed: "192.168.1.30",
 * "192.168.1.30:8443", "https://192.168.1.30/" or ".../api/junghome".
 * @returns {{ host: string, port: number, key: string } | { error: string }}
 */
export function parseAddress(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { error: 'empty' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(text)) return { error: 'invalid' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'https:') return { error: 'scheme' };
  if (url.username || url.password) return { error: 'credentials' };
  if (!/^\/((api\/junghome)\/?)?$/i.test(url.pathname) || url.search || url.hash) {
    return { error: 'path' };
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[')) {
    host = host.slice(1, -1);
    if (/^ff/i.test(host) || host === '::') return { error: 'broadcast' };
  } else if (IPV4.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((p) => p > 255)) return { error: 'invalid' };
    if (parts[0] === 0 || (parts[0] >= 224 && parts[0] <= 239) || parts.every((p) => p === 255)) {
      return { error: 'broadcast' };
    }
  } else if (!HOSTNAME.test(host)) {
    return { error: 'invalid' };
  } else if (/\.local$/.test(host)) {
    // mDNS names do not resolve inside the container (bridge network).
    return { error: 'local-name' };
  }
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!(port >= 1 && port <= 65535)) return { error: 'invalid' };
  const shown = host.includes(':') ? `[${host}]` : host;
  return { host, port, key: `${shown}:${port}` };
}

/**
 * A SHA-256 certificate fingerprint as Node shows it (`AB:CD:...`, 32 bytes),
 * from hex with or without colons; '' is none.
 * @returns {{ fingerprint?: string, error?: 'fingerprint' }}
 */
export function parseFingerprint(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^sha-?256[:=\s]*/i, '');
  if (text === '') return {};
  const hex = text.replace(/[:\s]/g, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) return { error: 'fingerprint' };
  return { fingerprint: hex.toUpperCase().match(/../g).join(':') };
}

/** The sockets declared safe: function ids separated by commas, spaces or semicolons. */
export function parseSafeSockets(raw) {
  const safe = new Set();
  const invalid = [];
  for (const entry of String(raw ?? '').split(/[\s,;]+/)) {
    if (entry === '') continue;
    if (FUNCTION_ID.test(entry) && safe.size < LIMITS.safeSockets) safe.add(entry);
    else invalid.push(entry.slice(0, 20));
  }
  return { safe, invalid };
}

/** Only true (or "true") turns an option on: anything else keeps it off. */
const on = (raw) => raw === true || raw === 'true';
/** Only false (or "false") turns live updates off. */
const notOff = (raw) => !(raw === false || raw === 'false');

const bounded = (raw, { min, max, default: fallback }) => {
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n))) : fallback;
};

/**
 * @returns {{ host?: string, port?: number, address?: string, token: string,
 *   fingerprint?: string, error?: string, live: boolean, pollInterval: number,
 *   safeSockets: Set<string>, invalidSockets: string[], allowScenes: boolean,
 *   allowHeating: boolean, language: 'fr'|'en' }}
 */
export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const target = parseAddress(c.gateway_address);
  const token = typeof c.api_token === 'string' ? c.api_token.trim() : '';
  const pin = parseFingerprint(c.certificate_fingerprint);
  const sockets = parseSafeSockets(c.safe_sockets);
  let error = target.error ?? pin.error;
  if (!error && token !== '' && !TOKEN.test(token)) error = 'bad-token';
  return {
    host: target.host,
    port: target.port,
    address: target.key,
    token: error === 'bad-token' ? '' : token,
    fingerprint: pin.fingerprint,
    error,
    live: notOff(c.live_updates),
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    safeSockets: sockets.safe,
    invalidSockets: sockets.invalid,
    allowScenes: on(c.allow_scenes),
    allowHeating: on(c.allow_heating_setpoints),
    language: LANGUAGES.includes(c.language) ? c.language : DEFAULT_CONFIG.language,
  };
}

/** Two configurations that run the same way (a reconnection to Gladys keeps everything). */
export const sameConfig = (a, b) =>
  JSON.stringify({ ...a, safeSockets: [...a.safeSockets].sort() }) ===
  JSON.stringify({ ...b, safeSockets: [...b.safeSockets].sort() });
