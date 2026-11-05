import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseAddress,
  parseFingerprint,
  parseSafeSockets,
  sameConfig,
} from '../src/config.js';
import { TOKEN } from './helpers/fakeGateway.js';

test('the address: IP, port, https URL; never a path, credentials, http, .local nor broadcast', () => {
  assert.deepEqual(parseAddress('192.168.1.30'), {
    host: '192.168.1.30',
    port: 443,
    key: '192.168.1.30:443',
  });
  assert.deepEqual(parseAddress(' https://192.168.1.30:8443/api/junghome/ '), {
    host: '192.168.1.30',
    port: 8443,
    key: '192.168.1.30:8443',
  });
  assert.equal(parseAddress('gateway.lan').host, 'gateway.lan');
  assert.equal(parseAddress('[fd00::1]').key, '[fd00::1]:443');
  for (const [raw, error] of [
    ['', 'empty'],
    ['http://192.168.1.30', 'scheme'],
    ['https://u:p@192.168.1.30', 'credentials'],
    ['192.168.1.30/other', 'path'],
    ['192.168.1.30?x=1', 'path'],
    ['junghome-001122334455.local', 'local-name'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.251', 'broadcast'],
    ['0.0.0.0', 'broadcast'],
    ['[ff02::1]', 'broadcast'],
    ['192.168.1.300', 'invalid'],
    ['192.168.1.30\r\nX: y', 'invalid'],
    ['bad_host!', 'invalid'],
  ]) {
    assert.equal(parseAddress(raw).error, error, raw);
  }
});

test('the fingerprint: 64 hex digits, any case, with or without colons', () => {
  const hex = 'ab'.repeat(32);
  const shown = 'AB:'.repeat(31) + 'AB';
  assert.equal(parseFingerprint(hex).fingerprint, shown);
  assert.equal(parseFingerprint(`SHA256=${shown.toLowerCase()}`).fingerprint, shown);
  assert.deepEqual(parseFingerprint(''), {});
  assert.equal(parseFingerprint('ab'.repeat(31)).error, 'fingerprint');
  assert.equal(parseFingerprint(`${hex}zz`).error, 'fingerprint');
});

test('the sockets declared safe: function ids only, bounded', () => {
  const { safe, invalid } = parseSafeSockets('idsock2, idabc; bad.id  ../x id:1');
  assert.deepEqual([...safe], ['idsock2', 'idabc']);
  assert.deepEqual(invalid, ['bad.id', '../x', 'id:1']);
  const many = Array.from({ length: 150 }, (_, i) => `id${i}`).join(',');
  assert.equal(parseSafeSockets(many).safe.size, 100);
});

test('normalizeConfig: defaults, options off unless true, token checked', () => {
  const c = normalizeConfig({ gateway_address: '10.0.0.2', api_token: ` ${TOKEN} ` });
  assert.equal(c.token, TOKEN);
  assert.equal(c.error, undefined);
  assert.equal(c.live, true);
  assert.equal(c.pollInterval, 60);
  assert.equal(c.allowScenes, false);
  assert.equal(c.allowHeating, false);
  assert.equal(c.language, 'fr');
  for (const v of [1, '1', 'yes', null, undefined]) {
    assert.equal(normalizeConfig({ allow_scenes: v }).allowScenes, false, String(v));
    assert.equal(normalizeConfig({ allow_heating_setpoints: v }).allowHeating, false, String(v));
  }
  assert.equal(normalizeConfig({ allow_heating_setpoints: 'true' }).allowHeating, true);
  assert.equal(normalizeConfig({ live_updates: 'false' }).live, false);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 3600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: true }).pollInterval, 60);
  const bad = normalizeConfig({ gateway_address: '10.0.0.2', api_token: 'abc\r\ndef' });
  assert.equal(bad.error, 'bad-token');
  assert.equal(bad.token, '', 'a token refused is never kept to be sent');
  assert.equal(
    normalizeConfig({ gateway_address: '10.0.0.2', certificate_fingerprint: 'zz' }).error,
    'fingerprint',
  );
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG).filter((k) => k.startsWith('gladys_')),
    [],
  );
});

test('sameConfig ignores the order of the safe sockets', () => {
  const a = normalizeConfig({ gateway_address: '10.0.0.2', safe_sockets: 'ida,idb' });
  const b = normalizeConfig({ gateway_address: '10.0.0.2', safe_sockets: 'idb ida' });
  assert.ok(sameConfig(a, b));
  assert.ok(
    !sameConfig(a, normalizeConfig({ gateway_address: '10.0.0.3', safe_sockets: 'ida,idb' })),
  );
});
