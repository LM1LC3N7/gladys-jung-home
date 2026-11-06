// -----------------------------------------------------------------------------
// The integration: one JUNG HOME gateway, its functions (lights, dimmers,
// sockets, covers, room thermostats, rocker buttons, sensors) and scenes
// turned into Gladys devices; the live socket feeding the states; commands
// sent back over REST, one HTTPS connection each, on the pinned certificate.
//
// Reads: GET /functions/ at the interval (every 5 min with the live socket,
// which brings each change), never sooner than the interval after the last
// one, even across a restart (/data). A refused token stops everything until
// the user acts; a 429 pauses every path but the stops.
//
// Commands. Protective ones (turn off, cover stop and close, frost
// protection) are never held back: no option, no bound, no pause, no queue,
// no read nor command in flight, no identity check stops them; they cancel
// what waits for the same target. A switch-off or a frost protection is kept
// (in /data) until a read started after the gateway's answer shows it applied;
// it is sent again at most 3 times when a read shows it is not, and only a
// send the gateway answered counts. Other commands leave within 3.5 s or not
// at all, after every check (option, identity, token, pause), checked again
// right before the first byte.
//
// Order: every request gets a number when it leaves (`beforeSend`); a read
// that started before a command of a target never applies to that target
// after it. Clocks: wall time only for /data, monotonic for every decision.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseAddress, sameConfig } from './config.js';
import { CLIENT_NAME, LIMITS, TIMINGS } from './constants.js';
import { GatewayError, createGateway, readFingerprint, register } from './gateway.js';
import { T, word } from './i18n.js';
import { openLive } from './live.js';
import {
  Refusal,
  applied,
  buildModel,
  datapointOf,
  emptyModel,
  numberOf,
  functionsOf,
  pressOf,
  scenesOf,
  stopFromDevice,
  valuesOf,
} from './model.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, newSalt, normalizeMemory, tokenMark } from './store.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/** The fields of a created feature kept when a device is published again. */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];

const SERIAL = /^[A-Za-z0-9-]{1,40}$/;

export class JungHomeApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'jung-home' }),
    store = fileStore(),
    now = Date.now,
    mono = () => performance.now(),
    timers = globalThis,
    live = openLive,
    fingerprint = readFingerprint,
    registerToken = register,
    request,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.mono = mono;
    this.timers = timers;
    this.openLive = live;
    this.readFingerprint = fingerprint;
    this.registerToken = registerToken;
    this.request = request;
    this.raw = {};
    this.config = normalizeConfig();
    this.memory = emptyMemory();
    /** 'unloaded' | 'loaded' | 'unreadable' */
    this.memoryState = 'unloaded';
    this.generation = 0;
    this.started = false;
    this.closed = false;
    this.connectSeq = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
    // Session (reset at each start).
    this.client = null;
    this.abort = new AbortController();
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.reading = false;
    this.readTimer = undefined;
    this.readDue = 0;
    this.lastReadMono = -Infinity;
    this.blocked = false;
    this.pauseEnd = -Infinity;
    this.pinError = undefined;
    /** identity: key used in the ids, whether read and matched this session, a mismatch seen */
    this.identity = { key: undefined, verified: false, mismatch: undefined, unreadable: false };
    this.functions = new Map();
    this.scenes = [];
    this.model = emptyModel();
    this.known = new Map();
    this.publishedDevices = undefined;
    this.transports = new Map();
    this.lastStatus = undefined;
    // Live socket.
    this.live = null;
    this.liveState = 'off';
    this.liveTimer = undefined;
    this.liveFailures = 0;
    this.liveOpenedAt = undefined;
    this.liveMark = 0;
    this.scenesDue = -Infinity;
    this.scenesFailures = 0;
    this.presses = new Map();
    // Commands and stops.
    this.counter = 0;
    /** target -> mark of the last request that left for it */
    this.lastSent = new Map();
    /** target -> number of stops received (a queued command of an older number is cancelled) */
    this.epochs = new Map();
    this.stopCount = 0;
    /** `${address} ${fid}` -> guard */
    this.guards = new Map();
    this.guardTimer = undefined;
    this.chains = new Map();
    this.slotsUsed = 0;
    this.slotWaiters = [];
    this.followUps = new Set();
    this.unconfirmed = new Set();
    // Values sent to Gladys.
    /** feature id -> { value, at (monotonic) } */
    this.lastValues = new Map();
    this.created = new Set();
    this.createdIds = new Set();
    // Buttons of the configuration screen.
    this.registering = undefined;
    this.lastTest = undefined;
    this.pendingTrust = undefined;
    this.lastAttemptSaved = -Infinity;
    this.publisher = new StatePublisher({ gladys, logger, now: mono, timers });
  }

  // --- /data ---------------------------------------------------------------------

  /** A promise bounded in time: a slow /data never holds what waits on it. */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => reject(new Error('timed out')), ms);
      Promise.resolve(promise).then(
        (v) => {
          this.timers.clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          this.timers.clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async loadMemory() {
    if (this.memoryState !== 'unloaded') return;
    try {
      const raw = await this.bounded(this.store.load(), TIMINGS.dataWait);
      this.memory = normalizeMemory(raw, this.now());
      this.memoryState = 'loaded';
    } catch (err) {
      // Unreadable is not empty: nothing learnt is written over it in this run.
      this.memoryState = 'unreadable';
      this.logger.warn(
        `JUNG HOME: /data unreadable (${err?.message ?? 'error'}): nothing kept this run`,
      );
    }
    const left = (this.memory.pausedUntil ?? 0) - this.now();
    if (left > 0) this.pauseEnd = this.mono() + Math.min(left, TIMINGS.rateLimitMax);
    // The last read of a previous run paces Scan and Test too (written at most
    // once a minute: it may have been up to a minute later than kept).
    if (this.memory.lastReadAt !== null) {
      const ago = Math.max(0, this.now() - this.memory.lastReadAt - TIMINGS.attemptWriteEvery);
      this.lastReadMono = Math.max(this.lastReadMono, this.mono() - ago);
    }
  }

  /** Writes /data in the background (never awaited on a command path). */
  saveSoon() {
    if (this.memoryState !== 'loaded') return Promise.reject(new Error('/data unreadable'));
    const write = Promise.resolve(this.store.save(this.memory));
    write.catch((err) => this.logger.warn(`JUNG HOME: writing /data failed (${err?.message})`));
    return write;
  }

  /** Writes /data and waits for it, bounded: for what must be kept before going on (a pin). */
  async saveNow() {
    if (this.memoryState !== 'loaded') throw new Error('/data unreadable');
    await this.bounded(this.store.save(this.memory), TIMINGS.dataWait);
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `JUNG HOME: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(Math.round(wait / 1000)));
      if (seq !== this.connectSeq || this.closed) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('JUNG HOME: start failed'));
      }, wait);
      return;
    }
    if (seq !== this.connectSeq || this.closed) return;
    this.configFailures = 0;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnected: true });
  }

  async configUpdated(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnected: false });
  }

  /** The same configuration keeps the session; another one starts again. */
  async applyConfig(raw, { reconnected }) {
    const next = normalizeConfig(raw);
    if (sameConfig(next, this.config)) {
      this.raw = { ...(raw ?? {}) };
      // Gladys may have restarted: what it keeps in memory only is sent again
      // (status, Discovery, badges), never an old value as a new one.
      this.lastStatus = undefined;
      this.publishedDevices = undefined;
      this.transports.clear();
      this.refreshCreated();
      await this.publishDevices();
      await this.showStatus();
      await this.publishAllTransports();
      return;
    }
    const c = this.config;
    if (
      next.address === c.address &&
      next.token === c.token &&
      next.fingerprint === c.fingerprint &&
      !next.error
    ) {
      // Options only (sockets, scenes, heating, language, live, interval): the
      // session goes on; the Discovery is rebuilt at once, the reads keep their pace.
      this.raw = { ...(raw ?? {}) };
      this.config = next;
      this.rebuild();
      await this.publishDevices();
      const generation = this.generation;
      if (!next.live) this.closeLive('off');
      if (this.online && !this.reading) {
        this.scheduleRead(
          generation,
          clamp(this.lastReadMono + this.readInterval() - this.mono(), 0, this.readInterval()),
        );
      }
      if (next.live && this.online && !this.live && this.liveState !== 'opening')
        this.startLive(generation);
      await this.showStatus();
      await this.publishAllTransports();
      return;
    }
    if (!reconnected) this.logger.info('JUNG HOME: configuration changed, starting again');
    await this.start(raw);
  }

  /**
   * A new session. The first read is `tick`'s to time: never sooner than the
   * interval after the last read of this gateway (this run, or /data after a
   * restart), nor during a pause; a new address or a new token reads at once.
   * `read`: the function list the Test button has just read (with the
   * identity it saw), taken as the read of this session (never a second read
   * right after it).
   */
  async start(raw = {}, { read } = {}) {
    this.stop();
    const generation = this.generation;
    this.raw = { ...(raw ?? {}) };
    const previous = { address: this.config.address, token: this.config.token };
    this.config = normalizeConfig(raw);
    await this.loadMemory();
    if (!this.current(generation)) return;
    if (
      previous.address !== undefined &&
      previous.token !== this.config.token &&
      this.memory.refused
    ) {
      // Another token saved while running is tried: the refusal kept in /data
      // is an older token's (its 6-bit mark alone would take the new one for
      // it 1 time in 64).
      this.memory.refused = null;
      this.saveSoon().catch(() => {});
    }
    if (
      previous.address !== undefined &&
      (previous.address !== this.config.address || previous.token !== this.config.token)
    ) {
      // Another gateway or another token, saved while running: read at once.
      this.lastReadMono = -Infinity;
    }
    if (previous.address !== this.config.address) {
      this.functions = new Map();
      this.scenes = [];
      this.model = emptyModel();
      this.known.clear();
      this.lastValues.clear();
    }
    this.abort = new AbortController();
    this.identity = read?.identity ?? {
      key: this.storedIdentity(),
      verified: false,
      mismatch: undefined,
      unreadable: false,
    };
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.pinError = undefined;
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.transports.clear();
    this.refreshCreated();
    this.publisher.start();
    this.adoptConfigPin();
    this.blocked = this.refusalKept();
    // The stops kept in /data for this gateway leave first: before any read,
    // before the identity is read again.
    this.restoreGuards();
    this.flushGuards();
    if (this.config.error || !this.config.token) {
      await this.showStatus();
      return;
    }
    if (read) {
      await this.takeRead(read.list, read.startMark);
      if (this.current(generation)) this.afterRead(generation);
      return;
    }
    this.rebuild();
    await this.publishDevices();
    await this.showStatus();
    if (!this.current(generation)) return;
    // `tick` puts the read off to its time (interval after the last read, pause).
    this.scheduleRead(generation, 0);
  }

  /** The reads, the live socket and the timers of this run end; a stop in flight goes on. */
  stop({ shutdown = false } = {}) {
    this.generation += 1;
    this.timers.clearTimeout(this.readTimer);
    this.timers.clearTimeout(this.liveTimer);
    this.readTimer = undefined;
    this.liveTimer = undefined;
    for (const timer of this.followUps) this.timers.clearTimeout(timer);
    this.followUps.clear();
    this.abort.abort();
    this.publisher.stop();
    this.closeLive('off');
    this.client = null;
    this.online = false;
    this.reading = false;
    if (shutdown) {
      this.closed = true;
      this.timers.clearTimeout(this.configTimer);
      this.timers.clearTimeout(this.guardTimer);
      this.configTimer = undefined;
      this.guardTimer = undefined;
    }
  }

  /** The container stops: everything ends; /data keeps the last state (bounded wait). */
  async shutdown() {
    this.stop({ shutdown: true });
    this.stopAbort?.abort();
    this.registerAbort?.abort();
    if (this.memoryState === 'loaded') {
      this.memory.guards = this.guardRecords();
      await this.saveNow().catch(() => {});
    }
  }

  current(generation) {
    return generation === this.generation && !this.closed;
  }

  pauseLeft() {
    return Math.max(0, this.pauseEnd - this.mono());
  }

  paused() {
    return this.pauseLeft() > 0;
  }

  // --- Pin, identity, token refusal ---------------------------------------------------

  /** The pin of the configuration's address: the field typed by the user, else /data. */
  pin(address = this.config.address) {
    if (address === this.config.address && this.config.fingerprint) return this.config.fingerprint;
    return this.memory.pins[address];
  }

  /** A fingerprint typed in the configuration is kept in /data (it is the pin from then on). */
  adoptConfigPin() {
    const { address, fingerprint } = this.config;
    if (!address || !fingerprint || this.memory.pins[address] === fingerprint) return;
    if (this.memory.pins[address] !== undefined) delete this.memory.identities[address];
    this.memory.pins[address] = fingerprint;
    this.saveSoon().catch(() => {});
  }

  storedIdentity() {
    return this.config.address ? this.memory.identities[this.config.address] : undefined;
  }

  refusalKept() {
    const r = this.memory.refused;
    if (!r || r.address !== this.config.address || !this.config.token) return false;
    return tokenMark(r.salt, this.config.token) === r.mark;
  }

  /** The token was refused (401/403): kept, never tried again until the user acts. */
  refuseToken() {
    if (this.blocked) return;
    this.blocked = true;
    this.logger.warn(
      'JUNG HOME: the gateway refused the token; waiting for a new one or the Test button',
    );
    if (this.config.address && this.config.token) {
      const salt = newSalt();
      this.memory.refused = {
        address: this.config.address,
        salt,
        mark: tokenMark(salt, this.config.token),
      };
      this.saveSoon().catch(() => {});
    }
  }

  clearRefusal() {
    this.blocked = false;
    if (this.memory.refused) {
      this.memory.refused = null;
      this.saveSoon().catch(() => {});
    }
  }

  /**
   * Reads the identity of the gateway: its serial number, or its MAC on a
   * firmware without the serial. Learnt once per address (frozen), then
   * compared: a weaker answer or none is "unreadable", never another gateway.
   */
  async readIdentity(client, generation) {
    let seen;
    let mac = false;
    try {
      const serial = await client.serial({ timeout: TIMINGS.readTimeout });
      if (typeof serial === 'string' && SERIAL.test(serial.trim())) seen = `sn${serial.trim()}`;
    } catch (err) {
      // A 401/403 here is not a refused token (only the function list says so).
      if (err?.kind === 'rate' || err?.kind === 'pin') throw err;
      if (err?.kind === 'notfound') mac = true;
    }
    if (!seen && mac) {
      try {
        const raw = await client.mac({ timeout: TIMINGS.readTimeout });
        const hex = typeof raw === 'string' ? raw.toLowerCase().replace(/[:-]/g, '') : '';
        if (/^[0-9a-f]{12}$/.test(hex) && hex !== '000000000000') seen = `mac${hex}`;
      } catch (err) {
        if (err?.kind === 'rate' || err?.kind === 'pin') throw err;
      }
    }
    if (!this.current(generation)) return;
    const stored = this.storedIdentity();
    if (!seen) {
      this.identity = { ...this.identity, verified: false, unreadable: true };
      return;
    }
    if (stored === undefined) {
      this.identity = { key: seen, verified: true, mismatch: undefined, unreadable: false };
      if (this.memoryState === 'loaded') {
        this.memory.identities[this.config.address] = seen;
        this.saveSoon().catch(() => {});
      }
      return;
    }
    if (stored === seen) {
      this.identity = { key: stored, verified: true, mismatch: undefined, unreadable: false };
      return;
    }
    if (stored.startsWith('sn') && seen.startsWith('mac')) {
      // Never a downgrade: a serial learnt and only a MAC read is unreadable.
      this.identity = { key: stored, verified: false, mismatch: undefined, unreadable: true };
      return;
    }
    this.identity = { key: stored, verified: false, mismatch: seen, unreadable: false };
    this.logger.warn('JUNG HOME: another gateway answers at this address; commands refused');
  }

  // --- Reading -------------------------------------------------------------------

  readInterval() {
    return this.liveState === 'live' ? TIMINGS.resync : this.config.pollInterval * 1000;
  }

  scheduleRead(generation, ms) {
    this.timers.clearTimeout(this.readTimer);
    this.readDue = this.mono() + ms;
    this.readTimer = this.timers.setTimeout(() => {
      this.readTimer = undefined;
      if (this.current(generation)) {
        this.tick(generation).catch((err) => this.logger.error(`JUNG HOME loop: ${err?.message}`));
      }
    }, ms);
  }

  /** A gateway client of this run (address, pin and token frozen). */
  sessionClient() {
    if (!this.client) {
      this.client = createGateway({
        host: this.config.host,
        port: this.config.port,
        pin: this.pin(),
        token: this.config.token,
        request: this.request,
        signal: this.abort.signal,
      });
    }
    return this.client;
  }

  /** Records the time of a read before it leaves (in /data at most once a minute). */
  noteAttempt() {
    this.lastReadMono = this.mono();
    if (this.memoryState !== 'loaded') return;
    const now = this.mono();
    if (now - this.lastAttemptSaved < TIMINGS.attemptWriteEvery) return;
    this.lastAttemptSaved = now;
    this.memory.lastReadAt = this.now();
    this.saveSoon().catch(() => {});
  }

  async tick(generation) {
    if (!this.current(generation) || this.reading) return;
    if (this.blocked || this.config.error || !this.config.token) {
      await this.showStatus();
      return;
    }
    if (!this.pin()) {
      await this.showStatus();
      return;
    }
    if (this.paused()) {
      await this.showStatus();
      this.scheduleRead(generation, this.pauseLeft());
      return;
    }
    // Never sooner than the interval after the last read, whoever made it
    // (the Test button reads too): put off to its due time.
    const early = this.lastReadMono + this.config.pollInterval * 1000 - this.mono();
    if (early > 0) {
      this.scheduleRead(generation, early);
      return;
    }
    this.reading = true;
    const client = this.sessionClient();
    const previousRead = this.lastReadMono;
    this.noteAttempt();
    const startMark = ++this.counter;
    try {
      if (!this.identity.verified) await this.readIdentity(client, generation);
      if (!this.current(generation)) return;
      const list = await client.functions({ timeout: TIMINGS.readTimeout });
      if (!this.current(generation)) return;
      if (!Array.isArray(list)) throw new GatewayError('format', 'the function list is not a list');
      let scenes = this.scenes;
      if (this.mono() >= this.scenesDue) {
        try {
          scenes = scenesOf(await client.scenes({ timeout: TIMINGS.readTimeout }));
          this.scenesFailures = 0;
          this.scenesDue = -Infinity;
        } catch (err) {
          // A secondary list: never stops the values, never a refused token
          // (401/403 here: "not read", spaced, doubling up to 1 h). 429 pauses.
          if (err?.kind === 'rate') throw err;
          this.scenesFailures += 1;
          this.scenesDue =
            this.mono() +
            Math.min(TIMINGS.secondaryMax, TIMINGS.retryMin * 2 ** (this.scenesFailures - 1));
          this.logger.debug?.(`JUNG HOME: scenes not read (${err?.message})`);
        }
      }
      if (!this.current(generation)) return;
      this.scenes = scenes;
      await this.takeRead(list, startMark);
    } catch (err) {
      // A certificate refused at the handshake: nothing reached the gateway,
      // so it does not count as a read (the pace starts from the last real one).
      if (err?.kind === 'pin' || err?.kind === 'nopin') this.lastReadMono = previousRead;
      if (this.current(generation)) await this.fail(generation, err);
      return;
    } finally {
      if (this.current(generation)) this.reading = false;
    }
    if (!this.current(generation)) return;
    this.afterRead(generation);
  }

  /** A function list read (by the loop or the Test button): model, states, online, Discovery. */
  async takeRead(list, startMark) {
    this.adoptFunctions(list, startMark);
    const wasOnline = this.online;
    this.online = true;
    this.failures = 0;
    this.lastError = undefined;
    this.pinError = undefined;
    if (!wasOnline) {
      this.logger.info(
        `JUNG HOME: connected, ${this.model.counts.offered} functions, ${this.model.counts.scenes} scenes`,
      );
    }
    await this.publishDevices();
    await this.showStatus();
    await this.publishAllTransports();
  }

  /** After a read: the next one at the interval; the live socket opened when wanted. */
  afterRead(generation) {
    this.scheduleRead(generation, this.readInterval());
    if (
      this.config.live &&
      !this.live &&
      this.liveTimer === undefined &&
      this.liveState !== 'opening'
    ) {
      this.startLive(generation);
    }
  }

  retryDelay(err) {
    if (err?.kind === 'rate') {
      return clamp(
        err.retryAfter ?? TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMax,
      );
    }
    const backoff = Math.min(
      TIMINGS.retryMax,
      TIMINGS.retryMin * 2 ** Math.max(0, this.failures - 1),
    );
    return Math.max(backoff, this.config.pollInterval * 1000);
  }

  pause(err) {
    const delay = this.retryDelay(err);
    this.pauseEnd = Math.max(this.pauseEnd, this.mono() + delay);
    this.memory.pausedUntil = this.now() + delay;
    this.saveSoon().catch(() => {});
    return delay;
  }

  async fail(generation, err) {
    this.online = false;
    this.closeLive('off');
    this.timers.clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.lastError = err;
    if (err?.kind === 'auth') {
      this.refuseToken();
      await this.showStatus();
      await this.publishAllTransports();
      return;
    }
    if (err?.kind === 'pin' || err?.kind === 'nopin') {
      // A changed certificate: never learnt again by itself; the token is never sent.
      this.pinError = err;
    }
    this.failures += 1;
    const delay = err?.kind === 'rate' ? this.pause(err) : this.retryDelay(err);
    if (err instanceof GatewayError) {
      this.logger.warn(`JUNG HOME: ${err.message} (next read in ${Math.round(delay / 1000)} s)`);
    } else {
      this.logger.error('JUNG HOME: unexpected failure', err);
    }
    await this.showStatus();
    await this.publishAllTransports();
    if (this.current(generation)) this.scheduleRead(generation, delay);
  }

  /**
   * A request that failed on a side path (read back, command, scene): a 429
   * pauses. A 401/403 there is never a refused token: only the function list
   * decides, at its next read (at the interval, never brought forward).
   */
  sideError(err) {
    if (err?.kind === 'rate') this.pause(err);
    else if (err?.kind === 'auth') this.logger.debug?.('JUNG HOME: 401/403 on a side route');
  }

  /** The function list (read or live): model, Discovery, states. */
  adoptFunctions(list, startMark) {
    this.functions = functionsOf(list);
    this.rebuild();
    for (const fn of this.functions.values()) {
      for (const dp of fn.datapoints.values()) this.applyDatapoint(dp, startMark, { press: false });
    }
  }

  rebuild() {
    if (!this.identity.key || this.identity.mismatch) {
      this.model = emptyModel();
      return;
    }
    this.model = buildModel(
      (type, id) => this.gladys.externalIds(type, id),
      { gateway: this.identity.key, functions: this.functions, scenes: this.scenes },
      { language: this.config.language, safeSockets: this.config.safeSockets },
    );
  }

  /**
   * One datapoint read or pushed. A read that started before a command of its
   * function left never applies (the command may have changed it); it still
   * tells a kept stop whether it is applied when it started after its answer.
   */
  applyDatapoint(dp, startMark, { press = false } = {}) {
    if (press) {
      const button = this.model.buttons.get(dp.id);
      if (button) {
        this.press(button, dp);
        return;
      }
    }
    const guard = this.guardOf(dp.fid);
    if (guard) this.considerGuard(guard, dp, startMark);
    if ((this.lastSent.get(dp.fid) ?? 0) > startMark) return;
    const fn = this.functions.get(dp.fid);
    if (fn && fn.datapoints.has(dp.id)) fn.datapoints.set(dp.id, dp);
    const at = this.mono();
    for (const { featureId, value } of valuesOf(this.model, dp)) {
      this.lastValues.set(featureId, { value, at });
      if (this.created.has(featureId)) this.publisher.push(featureId, { state: value });
    }
  }

  /** A press of a rocker (live only): one click, the copy ~1 s later dropped. */
  press(button, dp) {
    const state = pressOf(dp);
    if (state === undefined) return;
    const now = this.mono();
    // The window counts from the last press kept (the click), not from a copy.
    const last = this.presses.get(button.fid);
    if (last !== undefined && now - last < TIMINGS.pressCopyWindow) return;
    this.presses.set(button.fid, now);
    if (this.created.has(button.featureId)) this.publisher.pushEvent(button.featureId, { state });
  }

  // --- Live socket -----------------------------------------------------------------

  startLive(generation) {
    if (!this.current(generation) || !this.online || this.live || this.blocked || this.paused())
      return;
    this.liveState = 'opening';
    const openMark = ++this.counter;
    this.liveMark = openMark;
    this.openLive({
      host: this.config.host,
      port: this.config.port,
      pin: this.pin(),
      token: this.config.token,
      timers: this.timers,
      onFrame: (frame) => {
        if (this.current(generation)) this.onFrame(frame);
      },
      onClose: (reason) => {
        if (!this.current(generation)) return;
        this.live = null;
        this.liveLost(generation, new GatewayError('network', reason));
      },
    })
      .then(async (session) => {
        if (!this.current(generation) || !this.online) {
          session.close();
          return;
        }
        this.live = session;
        this.liveState = 'live';
        this.liveOpenedAt = this.mono();
        this.logger.info('JUNG HOME: live updates on');
        await this.showStatus();
        await this.publishAllTransports();
        // Reads every 5 minutes from now on (the socket brings each change).
        if (!this.reading) {
          const next = Math.max(0, this.lastReadMono + TIMINGS.resync - this.mono());
          this.scheduleRead(generation, Math.min(next, TIMINGS.resync));
        }
      })
      .catch((err) => {
        if (!this.current(generation)) return;
        // A 401/403 on the socket is not a refused token: the socket is lost,
        // tried again later (doubling up to 1 h); the reads go on.
        if (err?.kind === 'rate') this.pause(err);
        this.liveLost(generation, err);
      });
  }

  liveLost(generation, err) {
    if (!this.current(generation)) return;
    if (this.liveOpenedAt !== undefined && this.mono() - this.liveOpenedAt >= TIMINGS.liveStable) {
      this.liveFailures = 0;
    }
    this.liveOpenedAt = undefined;
    this.liveState = 'down';
    this.liveFailures += 1;
    const max = err?.kind === 'auth' ? TIMINGS.secondaryMax : TIMINGS.liveRetryMax;
    const delay = Math.min(max, TIMINGS.liveRetryMin * 2 ** (this.liveFailures - 1));
    if (this.liveFailures <= 3 || this.liveFailures % 20 === 0) {
      this.logger.warn(
        `JUNG HOME: live updates lost (${err?.message ?? err}); socket again in ${Math.round(delay / 1000)} s`,
      );
    }
    this.timers.clearTimeout(this.liveTimer);
    this.liveTimer = this.timers.setTimeout(() => {
      this.liveTimer = undefined;
      this.startLive(generation);
    }, delay);
    // Without the socket, the reads come back to the interval.
    const interval = this.config.pollInterval * 1000;
    if (!this.reading && this.readDue - this.mono() > interval)
      this.scheduleRead(generation, interval);
    this.background(this.showStatus());
    this.background(this.publishAllTransports());
  }

  closeLive(state) {
    const session = this.live;
    this.live = null;
    session?.close();
    this.liveState = state;
    this.liveOpenedAt = undefined;
  }

  onFrame(frame) {
    // A frame is dated by the frame before it: what it says may predate a
    // command sent since (a read "started" then).
    const startMark = this.liveMark;
    this.liveMark = ++this.counter;
    if (frame.type === 'functions') {
      this.adoptFunctions(frame.list, startMark);
      this.background(this.publishDevices());
      return;
    }
    if (frame.type === 'scenes') {
      this.scenes = scenesOf(frame.list);
      this.rebuild();
      this.background(this.publishDevices());
      return;
    }
    if (frame.type === 'datapoint') {
      const dp = datapointOf(frame.datapoint);
      if (dp && this.functions.has(dp.fid)) this.applyDatapoint(dp, startMark, { press: true });
      return;
    }
    if (frame.type === 'message' && /^error/i.test(frame.text)) {
      this.logger.debug?.(`JUNG HOME gateway: ${frame.text.slice(0, 120)}`);
    }
  }

  // --- Discovery, badges, status --------------------------------------------------

  /** The devices of the model, merged: a device never loses a feature in a run. */
  async publishDevices() {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    for (const fresh of this.model.devices) {
      const previous = this.known.get(fresh.external_id);
      const mine = created.get(fresh.external_id);
      const features = new Map();
      for (const f of mine?.features ?? []) {
        features.set(
          f.external_id,
          Object.fromEntries(
            FEATURE_FIELDS.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
          ),
        );
      }
      for (const f of [...(previous?.features ?? []), ...fresh.features]) {
        if (!features.has(f.external_id)) features.set(f.external_id, f);
      }
      this.known.set(fresh.external_id, { ...fresh, features: [...features.values()] });
    }
    const list = [...this.known.values()];
    const json = JSON.stringify(list);
    if (json === this.publishedDevices) return;
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.publishedDevices = json;
    } catch (err) {
      this.logger.warn(`JUNG HOME: publishing the Discovery failed (${err?.message})`);
    }
  }

  transportOf(deviceId) {
    if (!this.online) return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    for (const [target, id] of this.model.targetDevices) {
      if (id !== deviceId) continue;
      if (this.guardOf(target)) {
        return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.stopKept };
      }
      if (this.unconfirmed.has(target)) {
        return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
      }
    }
    if (this.config.live && this.liveState === 'down') {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.noLive };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishAllTransports() {
    const entries = [];
    for (const deviceId of this.createdIds) {
      if (!this.known.has(deviceId)) continue;
      const badge = this.transportOf(deviceId);
      const key = JSON.stringify(badge);
      if (this.transports.get(deviceId) !== key) {
        this.transports.set(deviceId, key);
        entries.push({ external_id: deviceId, ...badge });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`JUNG HOME: badges failed (${err?.message})`));
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`JUNG HOME: setConnectionStatus failed (${err?.message})`));
  }

  /** The status from what is known now (one text, bounded). */
  statusText() {
    const c = this.config;
    const parts = [];
    let connected = false;
    if (c.error) parts.push(T.configError(c.error));
    else if (!c.token) {
      if (this.registerError) parts.push(T.register.failed(this.registerError));
      parts.push(T.noToken);
    } else if (this.pinError?.kind === 'pin') parts.push(T.pinChanged(this.pinError.fingerprint));
    else if (!this.pin()) parts.push(T.noPin);
    else if (this.blocked) parts.push(T.tokenRefused);
    else if (this.paused()) parts.push(T.paused(Math.ceil(this.pauseLeft() / 60_000)));
    else if (this.online) {
      connected = true;
      parts.push(
        T.connected(
          this.model.counts,
          this.config.live ? this.liveState : 'off',
          this.config.pollInterval,
        ),
      );
      if (this.identity.mismatch) parts.push(T.identityMismatch);
      else if (this.identity.unreadable && !this.identity.key) parts.push(T.identityUnknown);
      else if (!this.identity.verified) parts.push(T.identityUnverified);
    } else if (this.lastError) parts.push(T.failure(this.lastError));
    else parts.push(T.connecting);
    const guards = this.ownGuards();
    if (guards.length > 0) parts.push(T.guards(guards.map((g) => this.guardSummary(g))));
    if (c.invalidSockets.length > 0) parts.push(T.invalidSockets(c.invalidSockets));
    if (this.memoryState === 'unreadable') parts.push(T.dataUnreadable);
    return { connected, message: T.join(parts) };
  }

  async showStatus() {
    if (this.closed) return;
    const { connected, message } = this.statusText();
    await this.setStatus(connected, message);
  }

  /** A promise not awaited: its failure is logged. */
  background(promise) {
    promise?.catch?.((err) => this.logger.warn(`JUNG HOME: ${err?.message}`));
  }

  // --- Devices created by the user -------------------------------------------------

  refreshCreated() {
    const devices = this.gladys.devices ?? [];
    this.createdIds = new Set(devices.map((d) => d.external_id));
    this.created = new Set(devices.flatMap((d) => (d.features ?? []).map((f) => f.external_id)));
  }

  /** A device created (or updated): its fresh values only, never an old one as new. */
  async deviceCreated(device) {
    this.refreshCreated();
    if (device?.external_id) this.createdIds.add(device.external_id);
    for (const f of device?.features ?? []) {
      this.created.add(f.external_id);
      const last = this.lastValues.get(f.external_id);
      if (last && this.mono() - last.at <= TIMINGS.freshness && this.online) {
        this.publisher.push(f.external_id, { state: last.value });
      }
    }
    this.transports.delete(device?.external_id);
    await this.publishAllTransports();
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** The Scan button: never a read sooner than the interval after the last one. */
  async scan() {
    const generation = this.generation;
    const interval = this.config.pollInterval * 1000;
    if (this.reading || this.mono() - this.lastReadMono < interval || !this.config.token) {
      this.publishedDevices = undefined;
      await this.publishDevices();
      return;
    }
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    await this.tick(generation);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(code, ...args) {
    const text = T.denied[code];
    return new Refusal(
      code,
      word(typeof text === 'function' ? text(...args) : text, this.config.language),
    );
  }

  async setValue(device, feature, value) {
    // The deadline counts from the arrival of the command, before any wait.
    const received = this.mono();
    const writer = this.model.writers.get(feature?.external_id);
    let op;
    if (writer) {
      try {
        op = writer.write(value);
      } catch (err) {
        throw err instanceof Refusal ? this.refusal('badValue') : err;
      }
    } else {
      // Function list not known (before the first read, another gateway
      // answering): a stop still leaves, from the device's params.
      op = stopFromDevice(device, feature, value);
      if (!op) throw this.refusal(this.online ? 'notCommand' : 'notConnected');
    }
    try {
      if (op.protective) return await this.protect(op);
      return await this.command(op, received);
    } catch (err) {
      // Gladys shows the value asked for: the last value read goes again.
      this.gladys.forgetPublishedStates?.(feature.external_id);
      const last = this.lastValues.get(feature.external_id);
      if (last && this.created.has(feature.external_id)) {
        this.publisher.push(feature.external_id, { state: last.value });
      }
      throw err;
    }
  }

  /** Runs `task` after the previous one of the same target. */
  serialized(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** A slot for a non-protective request, within the deadline (stops never take one). */
  async slot(deadline) {
    if (this.slotsUsed < LIMITS.commandSlots) {
      this.slotsUsed += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve };
      waiter.timer = this.timers.setTimeout(
        () => {
          this.slotWaiters = this.slotWaiters.filter((w) => w !== waiter);
          reject(this.refusal('tooLate'));
        },
        Math.max(0, deadline - this.mono()),
      );
      this.slotWaiters.push(waiter);
    });
  }

  release() {
    const next = this.slotWaiters.shift();
    if (next) {
      this.timers.clearTimeout(next.timer);
      next.resolve();
    } else {
      this.slotsUsed = Math.max(0, this.slotsUsed - 1);
    }
  }

  /** Every check of a non-protective command (again right before its first byte). */
  checkReady(op) {
    const c = this.config;
    if (c.error || !c.token) throw this.refusal('notConfigured');
    if (this.blocked) throw this.refusal('tokenRefused');
    if (this.paused()) throw this.refusal('paused');
    if (!this.pin()) throw this.refusal('noPin');
    if (!this.online || this.closed) throw this.refusal('notConnected');
    if (this.identity.mismatch) throw this.refusal('identityMismatch');
    if (!this.identity.verified) throw this.refusal('identityUnverified');
    if (op.need === 'scenes' && !c.allowScenes) throw this.refusal('scenesOff');
    if (op.need === 'heating' && !c.allowHeating) throw this.refusal('heatingOff');
    if (op.need === 'safe' && !c.safeSockets.has(op.fid)) throw this.refusal('socketNotSafe');
    const guard = op.fid ? this.guardOf(op.fid) : undefined;
    if (guard?.inFlight) throw this.refusal('stopInFlight');
  }

  /** A non-protective command: sent within 3.5 s of its arrival, or not at all. */
  async command(op, received) {
    const deadline = received + TIMINGS.commandDeadline;
    this.checkReady(op);
    const epoch = this.epochs.get(op.target) ?? 0;
    const stops = this.stopCount;
    return this.serialized(op.target, async () => {
      this.checkReady(op);
      if (this.mono() > deadline) throw this.refusal('tooLate');
      await this.slot(deadline);
      // The slot is given back once the request is answered (not after the read back).
      let held = true;
      const release = () => {
        if (held) {
          held = false;
          this.release();
        }
      };
      try {
        return await this.send(op, deadline, epoch, stops, release);
      } finally {
        release();
      }
    });
  }

  async send(op, deadline, epoch, stops, release = () => {}) {
    const client = this.sessionClient();
    let mark;
    const beforeSend = () => {
      if (this.mono() > deadline) throw this.refusal('tooLate');
      this.checkReady(op);
      // A stop arrived since: what came before it never leaves after it.
      if (
        (this.epochs.get(op.target) ?? 0) !== epoch ||
        (op.kind === 'scene' && this.stopCount !== stops)
      ) {
        throw this.refusal('cancelled');
      }
      mark = ++this.counter;
      this.lastSent.set(op.target, mark);
    };
    const timeout = () => Math.max(300, deadline - this.mono());
    try {
      if (op.kind === 'scene')
        await client.recallScene(op.scene, { timeout: timeout(), beforeSend });
      else
        await client.setDatapoint(op.fid, op.dpid, op.key, op.value, {
          timeout: timeout(),
          beforeSend,
        });
    } catch (err) {
      if (err instanceof Refusal) throw err;
      if (!err?.sent) throw this.refusal('notSent', err?.message ?? 'error');
      this.sideError(err);
      if (err.kind === 'auth') throw this.refusal('authRoute');
      if (err.kind === 'rate') throw this.refusal('paused');
      if (err.answered && ['refused', 'notfound', 'redirect'].includes(err.kind)) {
        throw this.refusal('refused', err.message);
      }
      // Sent, and no answer (or a 5xx): it may have been done.
      if (op.fid) this.markUnconfirmed(op);
      throw this.refusal(op.kind === 'scene' ? 'sceneUnconfirmed' : 'sentUnconfirmed');
    }
    release();
    // The gateway took it: a stop kept for this target gives way to it.
    if (op.fid) this.liftGuard(op.fid, mark);
    if (op.kind === 'scene') return undefined;
    // Done only when a read started after the answer shows the value.
    const readMark = ++this.counter;
    let dp;
    try {
      dp = datapointOf(await client.datapoint(op.fid, op.dpid, { timeout: timeout() }), op.fid);
    } catch (err) {
      this.sideError(err);
    }
    if (dp) this.applyDatapoint(dp, readMark);
    if (applied(op, dp) === true) {
      this.unconfirmed.delete(op.fid);
      return undefined;
    }
    this.markUnconfirmed(op);
    throw this.refusal('notYetApplied');
  }

  /** Read back later (5 s, 20 s); the badge says it until a read shows the state. */
  markUnconfirmed(op) {
    this.unconfirmed.add(op.fid);
    this.background(this.publishAllTransports());
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const timer = this.timers.setTimeout(async () => {
        this.followUps.delete(timer);
        if (!this.current(generation) || !this.online || this.paused() || this.blocked) return;
        const readMark = ++this.counter;
        try {
          const dp = datapointOf(
            await this.sessionClient().datapoint(op.fid, op.dpid, { timeout: TIMINGS.readTimeout }),
            op.fid,
          );
          if (!dp || !this.current(generation)) return;
          this.applyDatapoint(dp, readMark);
          if (applied(op, dp) === true && this.unconfirmed.delete(op.fid)) {
            await this.publishAllTransports();
          }
        } catch (err) {
          this.sideError(err);
        }
      }, delay);
      this.followUps.add(timer);
    }
  }

  // --- Stops (protective commands) ------------------------------------------------

  guardKey(address, fid) {
    return `${address} ${fid}`;
  }

  guardOf(fid) {
    return this.config.address
      ? this.guards.get(this.guardKey(this.config.address, fid))
      : undefined;
  }

  ownGuards() {
    return [...this.guards.values()].filter((g) => g.address === this.config.address);
  }

  guardRecords() {
    // Only switch-offs and frost protections are kept (never a cover move).
    const kept = [...this.guards.values()]
      .filter((g) => g.kind === 'state')
      .map(({ address, fid, dpid, key, value, answered }) => ({
        address,
        fid,
        dpid,
        key,
        value,
        answered,
      }));
    // Guards of other addresses kept in /data are not lost.
    for (const g of this.memory.guards) {
      if (!this.guards.has(this.guardKey(g.address, g.fid))) kept.push(g);
    }
    return kept.slice(0, LIMITS.guards);
  }

  persistGuards() {
    if (this.memoryState !== 'loaded') return;
    this.memory.guards = this.guardRecords();
    this.saveSoon().catch(() => {});
  }

  /** The stops kept in /data for this address become live guards (sent first). */
  restoreGuards() {
    for (const g of this.memory.guards) {
      if (g.address !== this.config.address) continue;
      const key = this.guardKey(g.address, g.fid);
      if (this.guards.has(key)) continue;
      this.guards.set(
        key,
        this.newGuard(
          { ...g, target: g.fid, kind: 'state', protective: true },
          g.address,
          g.answered,
        ),
      );
      this.logger.warn(
        `JUNG HOME: a stop of ${g.fid} not seen applied before the restart, sent again`,
      );
    }
  }

  newGuard(op, address, answered = 0) {
    return {
      address,
      fid: op.fid,
      dpid: op.dpid,
      key: op.key,
      value: op.value,
      kind: op.kind,
      answered,
      ok: false,
      okMark: undefined,
      sentMark: undefined,
      inFlight: undefined,
      again: false,
      stuck: false,
      reason: undefined,
      state: 'waiting',
      // A cover close: the level known when it was clicked (undefined: unknown,
      // never "changed elsewhere"), and the reads in a row showing it opened since.
      close: op.kind === 'move' && op.key === 'level' && op.value === '100',
      before: undefined,
      changed: 0,
      needRead: false,
      reading: false,
    };
  }

  /** The level of a cover as last known (read or pushed), as a number, or undefined. */
  knownLevel(fid, dpid) {
    const level = numberOf(this.functions.get(fid)?.datapoints.get(dpid)?.values.get('level'));
    return Number.isInteger(level) && level >= 0 && level <= 100 ? level : undefined;
  }

  /**
   * A protective command: never held back by anything but a missing token,
   * pin or address (then kept, and sent as soon as they are there). The
   * answer to Gladys waits for the first try at most 3.5 s; the stop goes on
   * after it.
   */
  async protect(op) {
    const address = this.config.address;
    if (!address) throw this.refusal('notConfigured');
    this.epochs.set(op.target, (this.epochs.get(op.target) ?? 0) + 1);
    this.stopCount += 1;
    const key = this.guardKey(address, op.fid);
    const guard = this.newGuard(op, address);
    if (guard.close) guard.before = this.knownLevel(op.fid, op.dpid);
    this.guards.set(key, guard);
    // Kept first (not awaited: a slow /data never holds a stop).
    if (guard.kind === 'state') this.persistGuards();
    this.armGuardTimer();
    const first = this.sendGuard(guard);
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TIMINGS.commandDeadline);
    });
    await Promise.race([first, late]);
    this.timers.clearTimeout(timer);
    this.background(this.publishAllTransports());
    this.background(this.showStatus());
    if (guard.ok || guard.state === 'applied') return undefined;
    throw this.refusal('stopKept', this.guardSummary(guard));
  }

  /** Whether a guard can leave now; else it waits (kept) for what it needs. */
  guardSendable(guard) {
    const c = this.config;
    if (this.closed || this.guards.get(this.guardKey(guard.address, guard.fid)) !== guard)
      return false;
    if (guard.address !== c.address || !c.token || c.error) {
      guard.state = 'noToken';
      return false;
    }
    if (this.blocked) {
      guard.state = 'tokenRefused';
      return false;
    }
    if (!this.pin(guard.address)) {
      guard.state = 'noPin';
      return false;
    }
    return true;
  }

  /** Sends a guard now (with two quick retries within ~250 ms when it did not reach the gateway). */
  sendGuard(guard) {
    if (guard.inFlight) {
      guard.again = true;
      return guard.inFlight;
    }
    if (!this.guardSendable(guard)) return Promise.resolve();
    // A close sent again after a read of the cover leaves once for that read,
    // without quick retries: the cover may be opened by hand right after it.
    const quick = guard.close && guard.needRead ? [] : TIMINGS.stopQuickRetries;
    guard.inFlight = (async () => {
      for (let i = 0; i <= quick.length; i += 1) {
        if (i > 0) {
          await new Promise((resolve) => this.timers.setTimeout(resolve, quick[i - 1]));
          if (!this.guardSendable(guard)) return;
        }
        const outcome = await this.sendGuardOnce(guard);
        if (outcome !== 'unanswered') return;
      }
      // A close that did not reach the gateway is sent again only after a read
      // (the cover may have been opened by hand meanwhile).
      if (guard.close) guard.needRead = true;
    })().finally(() => {
      guard.inFlight = undefined;
      const again = guard.again;
      guard.again = false;
      // Asked again meanwhile (a flush, a new token): once more, unless taken.
      if (again && !guard.ok) this.retryGuard(guard);
    });
    return guard.inFlight;
  }

  stopClient(guard) {
    const target = parseAddress(guard.address);
    if (!this.stopAbort || this.stopAbort.signal.aborted) this.stopAbort = new AbortController();
    return createGateway({
      host: target.host,
      port: target.port,
      pin: this.pin(guard.address),
      token: this.config.token,
      request: this.request,
      signal: this.stopAbort.signal,
    });
  }

  async sendGuardOnce(guard) {
    const client = this.stopClient(guard);
    try {
      await client.setDatapoint(guard.fid, guard.dpid, guard.key, guard.value, {
        timeout: TIMINGS.stopTimeout,
        beforeSend: () => {
          const mark = ++this.counter;
          guard.sentMark = mark;
          this.lastSent.set(guard.fid, mark);
        },
      });
    } catch (err) {
      return this.guardFailed(guard, err);
    }
    if (this.guards.get(this.guardKey(guard.address, guard.fid)) !== guard) return 'ok';
    guard.answered += 1;
    guard.ok = true;
    guard.okMark = ++this.counter;
    guard.reason = undefined;
    if (guard.kind === 'move') {
      // A cover move is done once the gateway took it: never sent again on a
      // read (the user may have moved the cover since, from the wall or the app).
      guard.state = 'done';
      this.dropGuard(guard);
      this.background(this.readBackTarget(guard));
      return 'ok';
    }
    guard.state = 'sent';
    this.persistGuards();
    this.background(this.confirmGuard(guard));
    return 'ok';
  }

  /** What a failed send means for a stop; only an answer of the gateway counts as a send. */
  guardFailed(guard, err) {
    const kind = err?.kind;
    if (kind === 'auth') {
      // Not a refused token (only the function list says so): not counted,
      // kept, sent again at the stop pace.
      guard.state = 'authRoute';
      this.background(this.showStatus());
      return 'refusedRoute';
    }
    if (kind === 'pin') {
      this.pinError = err;
      guard.state = 'pinChanged';
      return 'unanswered';
    }
    if (kind === 'notfound') {
      // The function is not on the gateway (any more): nothing to stop.
      guard.state = 'unknown';
      this.dropGuard(guard);
      this.logger.warn(`JUNG HOME: stop of ${guard.fid}: unknown on the gateway, dropped`);
      return 'gone';
    }
    if (kind === 'refused' && err.answered) {
      guard.answered += 1;
      guard.state = 'refused';
      guard.reason = err.message;
      // Refused by the gateway 4 times (locked, wind alarm...): kept, shown, no more sends.
      if (guard.answered >= LIMITS.stopSends) guard.stuck = true;
      this.persistGuards();
      this.background(this.showStatus());
      return 'refused';
    }
    if (kind === 'rate') this.pause(err);
    guard.state = err?.sent ? 'noAnswer' : 'notSent';
    guard.reason = err?.message;
    return 'unanswered';
  }

  dropGuard(guard) {
    const key = this.guardKey(guard.address, guard.fid);
    if (this.guards.get(key) !== guard) return;
    this.guards.delete(key);
    this.memory.guards = this.memory.guards.filter((g) => this.guardKey(g.address, g.fid) !== key);
    this.persistGuards();
    this.background(this.publishAllTransports());
    this.background(this.showStatus());
  }

  /** A newer command of the target, taken by the gateway, lifts a kept stop sent before it. */
  liftGuard(fid, mark) {
    const guard = this.guardOf(fid);
    if (guard && !guard.inFlight && (guard.sentMark === undefined || guard.sentMark < mark)) {
      this.logger.info(`JUNG HOME: the stop of ${fid} gives way to a newer command`);
      this.dropGuard(guard);
    }
  }

  /** A read started after the answer: applied ends the guard; not applied sends it again (3 times at most). */
  considerGuard(guard, dp, startMark) {
    if (dp.id !== guard.dpid) return;
    // Only a read started after the last answer (refused: after the last send) tells.
    const after = guard.ok ? guard.okMark : guard.sentMark;
    if (after === undefined || startMark <= after) return;
    const result = applied(guard, dp);
    if (result === true) {
      guard.state = 'applied';
      this.dropGuard(guard);
      return;
    }
    if (result !== false || !guard.ok) return;
    if (guard.answered < LIMITS.stopSends) {
      guard.ok = false;
      guard.state = 'contradicted';
      this.sendGuard(guard);
    } else if (!guard.stuck) {
      guard.stuck = true;
      guard.state = 'notApplied';
      this.logger.warn(
        `JUNG HOME: stop of ${guard.fid} still not applied after ${guard.answered} sends`,
      );
      this.background(this.showStatus());
    }
  }

  async confirmGuard(guard) {
    const readMark = ++this.counter;
    let dp;
    try {
      dp = datapointOf(
        await this.stopClient(guard).datapoint(guard.fid, guard.dpid, {
          timeout: TIMINGS.readTimeout,
        }),
        guard.fid,
      );
    } catch {
      // Not read (any cause, 401/403 included): the stop timer reads again.
      return;
    }
    if (dp && guard.address === this.config.address) this.applyDatapoint(dp, readMark);
  }

  async readBackTarget(guard) {
    if (guard.address !== this.config.address || !this.online) return;
    const readMark = ++this.counter;
    try {
      const dp = datapointOf(
        await this.stopClient(guard).datapoint(guard.fid, guard.dpid, {
          timeout: TIMINGS.readTimeout,
        }),
        guard.fid,
      );
      if (dp) this.applyDatapoint(dp, readMark);
    } catch {
      // The next read brings it.
    }
  }

  /** Every kept stop of this address: sent (or read back) now. */
  flushGuards() {
    for (const guard of this.ownGuards()) this.workGuard(guard);
    this.armGuardTimer();
  }

  workGuard(guard) {
    if (guard.inFlight) {
      guard.again = true;
      return;
    }
    if (!guard.ok) {
      // Never taken by the gateway, or contradicted: sent (refusals counted, at most 4).
      if (guard.state !== 'refused' || guard.answered < LIMITS.stopSends) this.retryGuard(guard);
      return;
    }
    if (!guard.stuck) this.background(this.confirmGuard(guard));
  }

  retryGuard(guard) {
    if (guard.close && guard.needRead) this.background(this.checkClose(guard));
    else this.sendGuard(guard);
  }

  /**
   * A close that did not reach the gateway, before it is sent again: the level
   * is read. Closed: done. Closer than when clicked: moving, taken. More open
   * than when clicked in two reads in a row: opened elsewhere, the close is
   * dropped (never re-closed over a hand opening a read showed). Otherwise
   * sent again, once for this read. A read that fails sends nothing (the
   * stop timer reads again).
   */
  async checkClose(guard) {
    if (guard.reading || guard.inFlight || !this.guardSendable(guard)) return;
    guard.reading = true;
    let level;
    try {
      const dp = datapointOf(
        await this.stopClient(guard).datapoint(guard.fid, guard.dpid, {
          timeout: TIMINGS.readTimeout,
        }),
        guard.fid,
      );
      const n = numberOf(dp?.values.get('level'));
      level = Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
    } catch {
      return;
    } finally {
      guard.reading = false;
    }
    if (this.guards.get(this.guardKey(guard.address, guard.fid)) !== guard) return;
    if (level === 100) {
      guard.state = 'applied';
      this.dropGuard(guard);
      return;
    }
    if (guard.before !== undefined && level !== undefined && level > guard.before) {
      guard.state = 'done';
      this.dropGuard(guard);
      return;
    }
    if (guard.before !== undefined && level !== undefined && level < guard.before) {
      guard.changed += 1;
      if (guard.changed >= 2) {
        guard.state = 'changedElsewhere';
        this.logger.info(`JUNG HOME: close of ${guard.fid} dropped: opened elsewhere meanwhile`);
        this.dropGuard(guard);
      }
      return;
    }
    guard.changed = 0;
    this.sendGuard(guard);
  }

  /** While a stop is not done, it is worked on every 5 s, without end (no age limit). */
  armGuardTimer() {
    if (this.guardTimer !== undefined || this.closed) return;
    this.guardTimer = this.timers.setTimeout(() => {
      this.guardTimer = undefined;
      if (this.closed) return;
      const pending = this.ownGuards().filter((g) => !g.stuck);
      for (const guard of pending) this.workGuard(guard);
      if (pending.length > 0) this.armGuardTimer();
      this.background(this.showStatus());
    }, TIMINGS.stopRetry);
  }

  guardSummary(guard) {
    const fn = this.functions.get(guard.fid);
    return {
      name: fn?.label || guard.fid,
      state: guard.state,
      sends: guard.answered,
      reason: guard.reason,
    };
  }

  // --- Buttons of the configuration screen ------------------------------------------

  /** The address of the saved configuration, or a message. */
  savedTarget() {
    const target = parseAddress(this.raw.gateway_address);
    return target.error ? { error: T.configError(target.error) } : target;
  }

  /** Learns the certificate on a click (explicit pin), kept in /data before use. */
  async learnPin(target) {
    const fp = await this.readFingerprint({ host: target.host, port: target.port });
    if (this.memoryState !== 'loaded') return { error: T.pinNotKept(fp) };
    this.memory.pins[target.key] = fp;
    try {
      await this.saveNow();
    } catch {
      delete this.memory.pins[target.key];
      return { error: T.pinNotKept(fp) };
    }
    this.logger.info('JUNG HOME: certificate of the gateway pinned');
    return { fp, learnt: true };
  }

  /**
   * "Request access": pins the certificate if none yet, then ONE registration
   * request (approved in the JUNG HOME app within 3 minutes), in the
   * background; the token is saved in the configuration and used at once.
   */
  async requestAccess() {
    await this.loadMemory();
    const target = this.savedTarget();
    if (target.error) return target.error;
    if (this.registering) return T.register.busy;
    // A 429 pause holds every request but the stops, an access request too.
    if (this.paused()) return T.register.paused(Math.ceil(this.pauseLeft() / 60_000));
    let pin =
      target.key === this.config.address && this.config.fingerprint
        ? this.config.fingerprint
        : this.memory.pins[target.key];
    let learnt = false;
    try {
      if (!pin) {
        const result = await this.learnPin(target);
        if (result.error) return result.error;
        pin = result.fp;
        learnt = true;
      }
    } catch (err) {
      return T.failure(err);
    }
    this.registerError = undefined;
    this.registerAbort = new AbortController();
    this.registering = this.registerToken({
      host: target.host,
      port: target.port,
      pin,
      name: CLIENT_NAME,
      request: this.request,
      signal: this.registerAbort.signal,
    })
      .then(async (token) => {
        if (this.closed) return;
        this.memory.refused = null;
        this.blocked = false;
        if (this.memoryState === 'loaded') this.saveSoon().catch(() => {});
        await this.gladys.setConfig({ api_token: token });
        this.logger.info('JUNG HOME: access granted by the gateway, token saved');
        await this.start({ ...this.raw, api_token: token });
      })
      .catch((err) => {
        this.logger.warn(`JUNG HOME: access request ended (${err?.message ?? 'error'})`);
        // Said in the status until the next click (a 400 is the end of the 3 minutes).
        this.registerError = err;
        this.lastStatus = undefined;
        this.background(this.showStatus());
      })
      .finally(() => {
        this.registering = undefined;
      });
    return T.register.started(pin, learnt);
  }

  /**
   * "Test the connection": the certificate (pinned on this click when none),
   * the versions and the token. A success lifts a refused token (the kept
   * stops leave first) and accepts a gateway identity that changed.
   */
  async testConnection() {
    await this.loadMemory();
    const now = this.mono();
    if (this.lastTest && now - this.lastTest.at < TIMINGS.testSpacing) return this.lastTest.result;
    const result = await this.runTest();
    this.lastTest = { at: this.mono(), result };
    return result;
  }

  async runTest() {
    const c = this.config;
    if (c.error) return T.configError(c.error);
    // The session the test speaks for: another configuration saved meanwhile
    // gets nothing from it (token, identity, list).
    const generation = this.generation;
    const target = { host: c.host, port: c.port, key: c.address };
    let pin = this.pin();
    let learnt = false;
    try {
      if (!pin) {
        const r = await this.learnPin(target);
        if (r.error) return r.error;
        pin = r.fp;
        learnt = true;
        // The stops kept for want of a pin leave first, before the test reads.
        this.flushGuards();
      }
      // A 429 pause holds every request but the stops, the Test button's too.
      if (this.paused()) {
        const { message } = this.statusText();
        return T.test.paused(message, Math.ceil(this.pauseLeft() / 1000), pin, learnt);
      }
      const client = createGateway({
        host: c.host,
        port: c.port,
        pin,
        token: c.token,
        request: this.request,
      });
      if (!c.token) {
        await client.version({ timeout: TIMINGS.readTimeout });
        return T.test.noToken(pin, learnt);
      }
      // Never a read sooner than the interval after the last one (this run or,
      // from /data, the previous one): the last result is said instead. While
      // the token is refused (no read runs then) or another gateway answers
      // (reads go on, its functions are not offered), Test may try at once
      // (once per 10 s, the Test spacing).
      const wait = this.lastReadMono + c.pollInterval * 1000 - this.mono();
      if (wait > 0 && !this.blocked && !this.identity.mismatch) {
        const { message } = this.statusText();
        return T.test.waiting(message, Math.ceil(wait / 1000), pin, learnt);
      }
      this.noteAttempt();
      // Marked when it leaves: a command sent after it is never undone by it.
      const startMark = ++this.counter;
      const version = await client.version({ timeout: TIMINGS.readTimeout });
      // The token is accepted only on an answer of the function list (2xx).
      const list = await client.functions({ timeout: TIMINGS.readTimeout });
      if (!Array.isArray(list)) throw new GatewayError('format', 'the function list is not a list');
      const identity = { ...this.identity };
      await this.readIdentity(client, generation);
      const ok = T.test.ok({
        pin,
        learnt,
        api: typeof version?.api_version === 'string' ? version.api_version.slice(0, 12) : '',
        release:
          typeof version?.version_release === 'string' ? version.version_release.slice(0, 12) : '',
      });
      if (!this.current(generation)) return ok;
      const seen = this.identity;
      if (seen.mismatch && this.memoryState === 'loaded') {
        this.memory.identities[c.address] = seen.mismatch;
        try {
          await this.saveNow();
        } catch {
          this.identity = identity;
          return T.dataUnreadable;
        }
        if (!this.current(generation)) return ok;
        this.identity = {
          key: seen.mismatch,
          verified: true,
          mismatch: undefined,
          unreadable: false,
        };
        this.logger.info('JUNG HOME: new gateway identity accepted (Test button)');
      }
      const wasBlocked = this.blocked;
      if (wasBlocked) {
        this.clearRefusal();
        this.logger.info(
          'JUNG HOME: token accepted again (Test button), the kept stops leave first',
        );
      }
      // The list just read is the read of the session: taken at once (online
      // now, never "Connecting..." until the next interval), and never read
      // again right after it.
      const read = { list, startMark, identity: { ...this.identity } };
      if (wasBlocked || learnt || seen.mismatch || !this.online) {
        this.background(this.start(this.raw, { read }));
      } else {
        this.background(this.takeRead(list, startMark));
      }
      return ok;
    } catch (err) {
      if (err?.kind === 'rate') this.pause(err);
      if (err?.kind === 'auth' && this.current(generation)) this.refuseToken();
      if (err?.kind === 'pin' && this.current(generation)) this.pinError = err;
      if (!(err instanceof GatewayError)) this.logger.error('JUNG HOME: test failed', err);
      return T.failure(err);
    }
  }

  /**
   * "Trust the new certificate", in two clicks: the first shows the
   * fingerprint seen, the second (within 2 min, the same one seen again) pins it.
   */
  async trustCertificate() {
    await this.loadMemory();
    const c = this.config;
    if (c.error) return T.configError(c.error);
    let fp;
    try {
      fp = await this.readFingerprint({ host: c.host, port: c.port });
    } catch (err) {
      return T.failure(err);
    }
    if (fp === this.pin()) return T.trust.same(fp);
    if (c.fingerprint) return T.trust.typed(fp);
    const pending = this.pendingTrust;
    if (
      !pending ||
      pending.address !== c.address ||
      pending.fp !== fp ||
      this.mono() - pending.at > TIMINGS.trustWindow
    ) {
      this.pendingTrust = { address: c.address, fp, at: this.mono() };
      return T.trust.confirm(fp);
    }
    this.pendingTrust = undefined;
    if (this.memoryState !== 'loaded') return T.pinNotKept(fp);
    const before = {
      pin: this.memory.pins[c.address],
      identity: this.memory.identities[c.address],
    };
    this.memory.pins[c.address] = fp;
    // A new certificate is a replaced gateway (or card): its identity is learnt again.
    delete this.memory.identities[c.address];
    try {
      await this.saveNow();
    } catch {
      this.memory.pins[c.address] = before.pin;
      if (before.identity) this.memory.identities[c.address] = before.identity;
      return T.pinNotKept(fp);
    }
    this.logger.info('JUNG HOME: new certificate trusted (two clicks)');
    this.background(this.start(this.raw));
    return T.trust.done(fp);
  }
}
