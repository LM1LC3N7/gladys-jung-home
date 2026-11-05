// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute.
//
// The publisher keeps the LAST value of each feature, sends the pending ones
// every second within a per-minute budget (the budget counts every state
// sent, presses included) and skips the unchanged ones (publishChangedStates).
// Button presses are queued apart and all sent (publishStates): two presses
// in a row are two events. The clock is the monotonic one of the app.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

/** Presses kept while Gladys is unreachable or the budget is spent. */
const MAX_QUEUED_EVENTS = 500;

export class StatePublisher {
  constructor({
    gladys,
    logger,
    now = () => performance.now(),
    timers = globalThis,
    budget = LIMITS.statesPerMinute,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { state } | { text } */
    this.pending = new Map();
    /** Button presses: every one counts, even twice the same value in a row. */
    this.events = [];
    /** send times of the last minute */
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /**
   * A press of a button: never merged with the previous one nor skipped as
   * unchanged (a second "click" is a new press, not a repeated value).
   */
  pushEvent(featureId, value) {
    this.events.push({ device_feature_external_id: featureId, ...value });
    if (this.events.length > MAX_QUEUED_EVENTS) {
      this.events.shift();
    }
  }

  /** Forget a feature (deleted device): its pending value is dropped. */
  forget(featureIdPrefix) {
    const owned = (id) => id === featureIdPrefix || id.startsWith(`${featureIdPrefix}:`);
    this.events = this.events.filter((e) => !owned(e.device_feature_external_id));
    for (const key of this.pending.keys()) {
      if (owned(key)) this.pending.delete(key);
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < 60_000);
    let room = this.budget - this.window.length;
    let sent = 0;
    // A share of the budget is kept for the pending states (a burst of presses
    // never starves the lights and covers), and a small share for the presses.
    const reserve = Math.min(this.pending.size, LIMITS.statesReserve);
    const eventRoom = Math.max(Math.min(room, LIMITS.eventsReserve), room - reserve);
    if (eventRoom > 0 && this.events.length > 0) {
      // publishStates, not publishChangedStates: equal values are distinct presses.
      const events = this.events.splice(0, Math.min(eventRoom, 100));
      try {
        await this.gladys.publishStates(events);
      } catch (err) {
        this.events.unshift(...events);
        throw err;
      }
      for (let i = 0; i < events.length; i += 1) {
        this.window.push(now);
      }
      room -= events.length;
      sent += events.length;
    }
    if (room <= 0 || this.pending.size === 0) {
      return sent;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (room <= 0) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
      room -= 1;
    }
    if (batch.length === 0) {
      return sent;
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (let i = 0; i < (result?.count ?? batch.length); i += 1) {
        this.window.push(now);
      }
      return sent + (result?.count ?? batch.length);
    } catch (err) {
      // Keep the values for the next round, unless a newer one arrived meanwhile.
      for (const entry of batch) {
        const { device_feature_external_id: id, ...value } = entry;
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
