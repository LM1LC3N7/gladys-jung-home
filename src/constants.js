// -----------------------------------------------------------------------------
// The fixed values of the integration: the gateway API (docs/gateway-rest-api.md
// and docs/gateway-websocket.md of the junghome reference, MIT), the timings
// and the bounds. Changing a key here changes what users stored: never rename.
// -----------------------------------------------------------------------------

/** The actions of the configuration screen (manifest `actions`). */
export const ACTIONS = {
  REGISTER: 'request_access',
  TEST: 'test_connection',
  TRUST: 'trust_certificate',
};

/** The name Gladys registers under on the gateway (shown in the JUNG HOME app). */
export const CLIENT_NAME = 'Gladys';

/** REST paths, under https://<gateway>/api/junghome. */
export const API_BASE = '/api/junghome';
export const PATHS = {
  version: '/version/',
  register: '/register',
  functions: '/functions/',
  datapoint: (fid, dpid) => `/functions/${fid}/datapoints/${dpid}`,
  scenes: '/scenes/',
  scene: (id) => `/scenes/${id}`,
  serial: '/config/parameter/system_serial',
  mac: '/config/parameter/ip_mac',
};
export const WS_PATH = '/ws';
export const DEFAULT_PORT = 443;

/** Read interval (s) of the function list without live updates; with them, every 5 min. */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

/** Room thermostats (RTR): the range of `temperature_ctrl` (°C), step 0.5. */
export const SETPOINT = { min: 5, max: 30, step: 0.5 };

export const LANGUAGES = ['fr', 'en'];

export const TIMINGS = {
  /** Gladys cuts a command at 5 s: a non-protective one leaves within 3.5 s or not at all. */
  commandDeadline: 3500,
  /** One stop request: connection, TLS check and answer. */
  stopTimeout: 3000,
  /** The quick retries of a stop that did not reach the gateway (the ~250 ms budget). */
  stopQuickRetries: [80, 170],
  /** A stop not yet applied is worked on at this pace, without end. */
  stopRetry: 5000,
  /** Read back of a command or a stop after its answer. */
  followUps: [5000, 20_000],
  /** One read (TLS + request + answer), and the longest silence inside it. */
  readTimeout: 15_000,
  idleTimeout: 5000,
  connectTimeout: 5000,
  /** With the live socket, the full list is read again this often (missed frames). */
  resync: 5 * 60_000,
  /** Failure of a read: next try after this, doubling, at most retryMax (never under the interval). */
  retryMin: 30_000,
  retryMax: 15 * 60_000,
  /** 429: a pause between these bounds (Retry-After when given). */
  rateLimitMin: 60_000,
  rateLimitMax: 6 * 3600_000,
  /** Live socket: opening, ping, its answer, retries. */
  liveOpen: 10_000,
  livePing: 60_000,
  livePong: 15_000,
  liveRetryMin: 5000,
  liveRetryMax: 5 * 60_000,
  /** A secondary route (scenes, socket) refused or failing: tried again doubling up to this. */
  secondaryMax: 3600_000,
  liveStable: 60_000,
  /** getConfig() failed: tried again after these, then every minute, without end. */
  configRetry: [5000, 15_000, 30_000, 60_000],
  /** A value read longer ago than this is not sent to a device just created. */
  freshness: 2 * 60_000,
  /** Registration on the gateway: approved in the JUNG HOME app within 180 s. */
  registerTimeout: 185_000,
  /** Test button: one real test per this delay, else the last result. */
  testSpacing: 10_000,
  /** Second click of "Trust the new certificate" within this delay. */
  trustWindow: 120_000,
  /** The time of the last read is written to /data at most this often. */
  attemptWriteEvery: 60_000,
  /** Longest wait on /data where a wait is allowed (start, shutdown, a pin). */
  dataWait: 2000,
  /** Rocker presses: the copy the device firmware 2.2.0.x sends ~1 s later. */
  pressCopyWindow: 1200,
  /** States sent to Gladys every second, within the budget. */
  flushInterval: 1000,
  stateHeartbeat: 3600_000,
};

export const LIMITS = {
  responseBytes: 1024 * 1024,
  frameBytes: 1024 * 1024,
  functions: 300,
  datapoints: 32,
  values: 8,
  scenes: 200,
  text: 100,
  statesPerMinute: 300,
  /** Non-protective requests at the same time (reads aside); stops never wait for a slot. */
  commandSlots: 6,
  /** Kept stops in /data. */
  guards: 64,
  /** Answered sends of one stop: the first and three resends. */
  stopSends: 4,
  safeSockets: 100,
  /** Of the budget, kept for the states (presses never starve them), and for the presses. */
  statesReserve: 50,
  eventsReserve: 10,
};

/** Gladys COVER_STATE (shutter `state`). */
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
/** Gladys BUTTON_STATUS.CLICK; a button feature pressed. */
export const CLICK = 1;
export const PRESSED = 1;
