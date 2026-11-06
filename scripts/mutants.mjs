// Mutation checks of the guards: each mutant breaks one guard in a copy of the
// repository and must make a test fail (never hang: the whole process group is
// killed at the deadline). One at a time. Usage, from the repository:
//   memcap node scripts/mutants.mjs "$(mktemp -d)" [name filter]
// The directory given is the agent's own; it is emptied of each copy after use.
// node_modules is copied (never linked) into each copy.

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const C = 'test/commands.test.js';
const A = 'test/app.test.js';
const R = 'test/review-r1.test.js';
const M = 'test/model.test.js';
const G = 'test/gateway.test.js';

/** [name, file, from (found exactly once), to, test files]; `equivalent` ones are listed, not run. */
export const MUTANTS = [
  [
    'heating option',
    'src/app.js',
    "op.need === 'heating' && !c.allowHeating",
    "op.need === 'heating' && false",
    [C],
  ],
  [
    'scenes option',
    'src/app.js',
    "op.need === 'scenes' && !c.allowScenes",
    "op.need === 'scenes' && false",
    [C],
  ],
  [
    'safe socket',
    'src/app.js',
    "op.need === 'safe' && !c.safeSockets.has(op.fid)",
    "op.need === 'safe' && false",
    [C],
  ],
  [
    'epoch before send',
    'src/app.js',
    '(this.epochs.get(op.target) ?? 0) !== epoch ||',
    'false ||',
    [C],
  ],
  [
    'read before command',
    'src/app.js',
    'if ((this.lastSent.get(dp.fid) ?? 0) > startMark) return;',
    '',
    [C],
  ],
  [
    'guard read after answer',
    'src/app.js',
    'if (after === undefined || startMark <= after) return;',
    'if (after === undefined) return;',
    [C],
  ],
  [
    '4 answered sends',
    'src/app.js',
    'if (guard.answered < LIMITS.stopSends) {',
    'if (guard.answered < 99) {',
    [C],
  ],
  [
    'stuck refused',
    'src/app.js',
    'if (guard.answered >= LIMITS.stopSends) guard.stuck = true;',
    '',
    [R],
  ],
  [
    'lift only newer',
    'src/app.js',
    '(guard.sentMark === undefined || guard.sentMark < mark)',
    'true',
    [C],
  ],
  ['lift on 200', 'src/app.js', 'if (op.fid) this.liftGuard(op.fid, mark);', '', [C]],
  [
    'blocked guard',
    'src/app.js',
    "    if (this.blocked) {\n      guard.state = 'tokenRefused';\n      return false;\n    }",
    '',
    [C],
  ],
  ['pin check', 'src/gateway.js', 'if (seen !== pin) {', 'if (false) {', [G]],
  ['press copy', 'src/app.js', 'now - last < TIMINGS.pressCopyWindow', 'now - last < 0', [A]],
  ['first wait', 'src/app.js', 'let wait = fresh ? 0 : this.firstWait();', 'let wait = 0;', [C]],
  [
    'pause in tick',
    'src/app.js',
    '    if (this.paused()) {\n      await this.showStatus();',
    '    if (false) {\n      await this.showStatus();',
    [A],
  ],
  [
    'refusal kept',
    'src/app.js',
    'return tokenMark(r.salt, this.config.token) === r.mark;',
    'return false;',
    [A],
  ],
  [
    'setpoint max',
    'src/model.js',
    'v < SETPOINT.min || v > SETPOINT.max',
    'v < SETPOINT.min || v > 99',
    [M],
  ],
  ['freshness', 'src/app.js', 'this.mono() - last.at <= TIMINGS.freshness', 'true', [A]],
  [
    'identity verified',
    'src/app.js',
    "if (!this.identity.verified) throw this.refusal('identityUnverified');",
    '',
    [A],
  ],
  [
    'identity mismatch',
    'src/app.js',
    "if (this.identity.mismatch) throw this.refusal('identityMismatch');",
    '',
    [C],
  ],
  [
    'mismatch model',
    'src/app.js',
    'if (!this.identity.key || this.identity.mismatch) {',
    'if (!this.identity.key) {',
    [R],
  ],
  [
    'too late before send',
    'src/app.js',
    "      if (this.mono() > deadline) throw this.refusal('tooLate');\n      this.checkReady(op);",
    '      this.checkReady(op);',
    [C],
  ],
  [
    'option in beforeSend',
    'src/app.js',
    "      if (this.mono() > deadline) throw this.refusal('tooLate');\n      this.checkReady(op);",
    "      if (this.mono() > deadline) throw this.refusal('tooLate');",
    [C],
  ],
  [
    'applied drop',
    'src/app.js',
    "    if (result === true) {\n      guard.state = 'applied';",
    "    if (false) {\n      guard.state = 'applied';",
    [C],
  ],
  ['move not kept', 'src/app.js', "    if (guard.kind === 'move') {", '    if (false) {', [C]],
  ['persist moves', 'src/app.js', ".filter((g) => g.kind === 'state')", '.filter(() => true)', [R]],
  [
    'not applied yet',
    'src/app.js',
    '    if (applied(op, dp) === true) {\n      this.unconfirmed.delete(op.fid);',
    '    if (true) {\n      this.unconfirmed.delete(op.fid);',
    [C],
  ],
  [
    'no downgrade',
    'src/app.js',
    "if (stored.startsWith('sn') && seen.startsWith('mac')) {",
    'if (false) {',
    [A],
  ],
  ['scan pace', 'src/app.js', 'this.mono() - this.lastReadMono < interval ||', '', [A]],
  [
    'two clicks trust',
    'src/app.js',
    'this.mono() - pending.at > TIMINGS.trustWindow',
    'false',
    [A],
  ],
  ['trust one click', 'src/app.js', 'pending.fp !== fp ||', '', [R]],
  ['trust typed', 'src/app.js', 'if (c.fingerprint) return T.trust.typed(fp);', '', [R]],
  ['test spacing', 'src/app.js', 'now - this.lastTest.at < TIMINGS.testSpacing', 'false', [R]],
  [
    'stopFromDevice fid check',
    'src/model.js',
    'return m && m[1] === fid ? id : undefined;',
    'return m ? id : undefined;',
    [M],
  ],
  [
    'quantity range',
    'src/model.js',
    'v !== undefined && v >= kind.min && v <= kind.max ? v : undefined',
    'v',
    [M],
  ],
  [
    'strict number',
    'src/model.js',
    '!/^-?\\d{1,9}(\\.\\d{1,6})?$/.test(text.trim())',
    'false',
    [M],
  ],
  // Review r1.
  [
    'I1 scenes auth',
    'src/app.js',
    "          if (err?.kind === 'rate') throw err;\n          this.scenesFailures += 1;",
    "          if (err?.kind === 'rate' || err?.kind === 'auth') throw err;\n          this.scenesFailures += 1;",
    [R],
  ],
  ['I1 scenes spaced', 'src/app.js', 'if (this.mono() >= this.scenesDue) {', 'if (true) {', [R]],
  [
    'I1 socket auth',
    'src/app.js',
    "        if (err?.kind === 'rate') this.pause(err);\n        this.liveLost(generation, err);",
    "        if (err?.kind === 'auth') return this.background(this.fail(generation, err));\n        this.liveLost(generation, err);",
    [R],
  ],
  [
    'I1 serial auth',
    'src/app.js',
    "      if (err?.kind === 'rate' || err?.kind === 'pin') throw err;\n      if (err?.kind === 'notfound') mac = true;",
    "      if (err?.kind === 'rate' || err?.kind === 'pin' || err?.kind === 'auth') throw err;\n      if (err?.kind === 'notfound') mac = true;",
    [R],
  ],
  [
    'I1 stop auth',
    'src/app.js',
    "      guard.state = 'authRoute';",
    "      this.refuseToken();\n      guard.state = 'authRoute';",
    [R],
  ],
  [
    'I1 side auth',
    'src/app.js',
    "    else if (err?.kind === 'auth') this.logger.debug?.('JUNG HOME: 401/403 on a side route');",
    "    else if (err?.kind === 'auth') this.refuseToken();",
    [R],
  ],
  [
    'I2 seed last read',
    'src/app.js',
    'this.lastReadMono = Math.max(this.lastReadMono, this.mono() - ago);',
    '',
    [R],
  ],
  [
    'I2 test pace',
    'src/app.js',
    '      if (wait > 0) {\n        const { message } = this.statusText();',
    '      if (false) {\n        const { message } = this.statusText();',
    [R],
  ],
  [
    'M1 test proves token',
    'src/app.js',
    '      const list = await client.functions({ timeout: TIMINGS.readTimeout });\n      if (!Array.isArray(list))',
    '      const list = [];\n      if (!Array.isArray(list))',
    [R],
  ],
  [
    'M2 register status',
    'src/app.js',
    '      if (this.registerError) parts.push(T.register.failed(this.registerError));',
    '',
    [R],
  ],
  [
    'M4 strict command',
    'src/model.js',
    "if (typeof value === 'string' && /^-?\\d{1,9}(\\.\\d{1,6})?$/.test(value)) return Number(value);",
    "if (typeof value === 'string' && value.trim() !== '') return Number(value);",
    [R],
  ],
  [
    'M5 server date',
    'src/gateway.js',
    'Number.isFinite(date) && Number.isFinite(now)',
    'Number.isFinite(date)',
    [R],
  ],
  [
    'M7 port',
    'src/config.js',
    "  if (!(port >= 1 && port <= 65535)) return { error: 'invalid' };",
    '',
    [R],
  ],
  ['close read first', 'src/app.js', '      if (guard.close) guard.needRead = true;', '', [R]],
  [
    'close changed twice',
    'src/app.js',
    'if (guard.changed >= 2) {',
    'if (guard.changed >= 99) {',
    [R],
  ],
  [
    'close two in a row',
    'src/app.js',
    'if (guard.changed >= 2) {',
    'if (guard.changed >= 1) {',
    [R],
  ],
  [
    'pin refusal not a read',
    'src/app.js',
    "if (err?.kind === 'pin' || err?.kind === 'nopin') this.lastReadMono = previousRead;",
    '',
    [R],
  ],
  [
    'press window from the click',
    'src/app.js',
    '    if (last !== undefined && now - last < TIMINGS.pressCopyWindow) return;\n    this.presses.set(button.fid, now);',
    '    this.presses.set(button.fid, now);\n    if (last !== undefined && now - last < TIMINGS.pressCopyWindow) return;',
    [R],
  ],
  [
    'flush after pin on Test',
    'src/app.js',
    '        learnt = true;\n        // The stops kept for want of a pin leave first, before the test reads.\n        this.flushGuards();',
    '        learnt = true;',
    [A, C],
  ],
];

/** Equivalent mutants, with the reason (no test can tell them apart). */
export const EQUIVALENT = [
  [
    'learnPin not kept',
    'src/app.js',
    "if (this.memoryState !== 'loaded') return { error: T.pinNotKept(fp) };",
    'saveNow() refuses an unreadable /data the same way',
  ],
];

function run(dir, tests, ms) {
  return new Promise((done) => {
    const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-timeout=60000', ...tests], {
      cwd: dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
      done({ code: 'TIMEOUT', out });
    }, ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

async function main() {
  const base = process.argv[2];
  const filter = process.argv[3];
  if (!base) throw new Error('give your own temporary directory (mktemp -d)');
  const modules = join(base, 'node_modules');
  cpSync(join(REPO, 'node_modules'), modules, { recursive: true });
  let survived = 0;
  for (const [name, file, from, to, tests] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = mkdtempSync(join(base, 'm-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      const n = text.split(from).length - 1;
      if (n !== 1) {
        console.log(`??       ${name}: ${n} matches`);
        survived += 1;
        continue;
      }
      writeFileSync(path, text.replace(from, to));
      const { code } = await run(dir, tests, 150_000);
      const killed = code !== 0 && code !== 'TIMEOUT';
      if (!killed) survived += 1;
      console.log(`${killed ? 'killed  ' : code === 'TIMEOUT' ? 'HANGS   ' : 'SURVIVED'} ${name}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(modules, { recursive: true, force: true });
  for (const [name, , , why] of EQUIVALENT) console.log(`equiv.   ${name}: ${why}`);
  process.exitCode = survived > 0 ? 1 : 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
