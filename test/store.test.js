import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory, tokenMark } from '../src/store.js';
import { TOKEN } from './helpers/fakeGateway.js';

const NOW = Date.UTC(2026, 10, 5, 12);
const FP = 'AB:'.repeat(31) + 'AB';

async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'jung-store-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('fileStore: no file is null, a file round-trips (0600), unreadable is an error', async (t) => {
  const d = await dir(t);
  const store = fileStore(join(d, 'state.json'));
  assert.equal(await store.load(), null);
  await store.save({ pins: { 'a:443': FP } });
  assert.deepEqual(await store.load(), { pins: { 'a:443': FP } });
  assert.equal((await stat(join(d, 'state.json'))).mode & 0o777, 0o600);
  await writeFile(join(d, 'state.json'), '{not json');
  await assert.rejects(store.load(), /not JSON/);
  await writeFile(join(d, 'state.json'), 'x'.repeat(70 * 1024));
  await assert.rejects(store.load(), /too large/);
});

test('fileStore: a special file (FIFO, directory) is refused without opening it', async (t) => {
  const d = await dir(t);
  await mkdir(join(d, 'dir.json'));
  await assert.rejects(fileStore(join(d, 'dir.json')).load(), /not a regular file/);
  execFileSync('mkfifo', [join(d, 'fifo.json')]);
  // Opening a FIFO with no writer would block: it must be refused first.
  await assert.rejects(fileStore(join(d, 'fifo.json')).load(), /not a regular file/);
});

test('fileStore: writes go one at a time, the last one wins', async (t) => {
  const d = await dir(t);
  const store = fileStore(join(d, 'state.json'));
  await Promise.all([1, 2, 3, 4, 5].map((n) => store.save({ n })));
  assert.deepEqual(JSON.parse(await readFile(join(d, 'state.json'), 'utf8')), { n: 5 });
});

test('normalizeMemory: bounded, repaired; future dates not trusted; guards checked', () => {
  const m = normalizeMemory(
    {
      pins: { '10.0.0.2:443': FP, 'bad host': FP, '10.0.0.3:443': 'nope' },
      identities: { '10.0.0.2:443': 'snJH001', '10.0.0.3:443': 'sn bad' },
      refused: { address: '10.0.0.2:443', salt: '0011223344556677', mark: 70 },
      pausedUntil: NOW + 30 * 3600_000,
      lastReadAt: NOW + 3600_000,
      guards: [
        {
          address: '10.0.0.2:443',
          fid: 'idl',
          dpid: 'idl-001',
          key: 'switch',
          value: '0',
          answered: 'x',
        },
        {
          address: '10.0.0.2:443',
          fid: 'idl',
          dpid: 'idl-001',
          key: 'switch',
          value: '0',
          answered: 2,
        },
        { address: '10.0.0.2:443', fid: 'idm', dpid: 'idm-001', key: 'switch', value: '1' },
        { address: '10.0.0.2:443', fid: 'idn', dpid: 'idx-001', key: 'switch', value: '0' },
        { address: '10.0.0.2:443', fid: 'idb', dpid: 'idb-001', key: 'level', value: '100' },
        {
          address: '10.0.0.2:443',
          fid: 'idr',
          dpid: 'idr-001',
          key: 'temperature_ctrl_preset',
          value: 'frost',
          answered: 9,
        },
      ],
    },
    NOW,
  );
  assert.deepEqual(m.pins, { '10.0.0.2:443': FP });
  assert.deepEqual(m.identities, { '10.0.0.2:443': 'snJH001' });
  assert.equal(m.refused, null, 'a mark out of 0..63 is no refusal');
  assert.equal(m.pausedUntil, NOW + 6 * 3600_000, 'a pause is 6 h at most');
  assert.equal(m.lastReadAt, NOW, 'a read in the future counts as now');
  assert.deepEqual(
    m.guards.map((g) => [g.fid, g.answered]),
    [
      ['idl', 0],
      ['idr', 4],
    ],
    'an unreadable count is 0; a switch-on, a cover move or a foreign datapoint is never a kept stop',
  );
  assert.deepEqual(normalizeMemory('junk', NOW).guards, []);
  assert.equal(normalizeMemory({ pausedUntil: NOW - 1 }, NOW).pausedUntil, null);
});

test('the refused-token mark: 6 bits only, salted (never enough to find the token)', () => {
  const salt = '0011223344556677';
  const mark = tokenMark(salt, TOKEN);
  assert.ok(Number.isInteger(mark) && mark >= 0 && mark < 64);
  // Brute force over many candidate tokens: about 1 in 64 share the mark.
  let same = 0;
  for (let i = 0; i < 6400; i += 1) if (tokenMark(salt, `${TOKEN}${i}`) === mark) same += 1;
  assert.ok(same > 50 && same < 160, `${same} collisions`);
  assert.notEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map((n) => tokenMark(`00112233445566${n}${n}`, TOKEN)).join(),
    String(mark).repeat(8),
  );
});
