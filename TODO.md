# TODO — JUNG HOME v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-05): REST client on a pinned TLS
      connection, live WebSocket, registration by approval in the JUNG HOME
      app, lights, dimmers, covers, sockets, room thermostats, rocker presses,
      sensors, scenes, kept stops, en/fr, docs, cover. Tested against a
      simulated gateway built from the reference docs only.
- [ ] **Milestone 2 — real gateway**: run against a real JUNG HOME gateway
      (firmware 2.1.x, API 1.5.0) and compare with the JUNG HOME app.
- [ ] **Milestone 3 — more**: slats (`angle`), colour temperature, awnings
      (inverted covers, per device), energy counter of sockets
      (`/devices/{id}?verbose=true`, experimental: lifetime counter rules),
      hold and release of rockers, scene recalls from physical keys as events.

## Decisions

- Version 0.1.0 set by hand in package.json, the lock, the manifest and
  `docker_image`. SDK `^0.16.0` (latest published, 2026-11-05). Not in the
  manifest (store rules): `keywords`, `countries` (DE, AT, CH, NL...).
- Reference: ernetas/junghome v1.6.1 (2026-10-27, MIT); only its protocol
  documentation and fixtures were used (no code copied). Runtime dependency
  `ws` (MIT) for the WebSocket: it takes the verified TLS socket
  (`createConnection`) and bounds frames before they are complete
  (`maxPayload`).
- Access: registration by approval only (`POST /register`, `user_name`
  "Gladys", one request per click, in the background, up to 185 s). Not by the
  network key password: it would store a mesh credential.
- TLS: the certificate is pinned explicitly (first click of "Request access"
  or "Test the connection", or typed); every connection is checked before
  its first byte; a changed certificate is never learnt alone (two clicks, or
  typed). One HTTPS connection per request, `Connection: close`.
- Identity: `sn<serial>` from `/config/parameter/system_serial`, else (404)
  `mac<MAC>`; frozen per address in /data; an empty serial (gateway booting)
  or a weaker answer is "unreadable", never another gateway. External ids:
  `function:<identity>_<function id>`, `scene:<identity>_<scene id>`.
- Commands over REST (PATCH datapoint: every set has its own answer), not over
  the WebSocket (errors there carry no message id). Commands confirmed by a
  read started after the answer.
- Protective: switch off (lights, sockets, brightness 0), cover stop and
  close (position 0 included), thermostat frost preset. Kept in /data: switch
  offs and frost only. A cover move ends at the gateway's answer (never sent
  again on a read: the user may have moved it since; never replayed after a
  restart).
- /data holds no token (secret rule): a kept stop leaves at start as soon as
  the configuration is read (before any read, before the identity), not
  before `getConfig()`.
- Sockets: never a switch unless declared safe (`safe_sockets`, function ids);
  undeclared: a read-only state and a "Turn off" button. JUNG HOME scenes and
  heating setpoints off by default; setpoint bounds 5 to 30 °C (RTR range of
  the reference), 0.5 °C steps rounded down.
- Thermostat `switch` datapoint not published: it tracks the heating output,
  not an on/off (reference, issue #121).
- Reads: GET /functions/ at the interval (60 s), every 5 min with the live
  socket; the time of the last read in /data before it leaves; a restart, the
  Test button or Scan never read sooner than the interval (Scan then publishes
  the Discovery again). `tick` alone times every read, the first one of a
  session included (the separate first wait from /data was the same rule
  twice: removed, review r3). Changing only the options keeps the session (no
  new read); a new address or a new token reads at once.
- Rocker presses: live frames only, one click per press edge, a press within
  1.2 s of the previous one of the same function dropped (device firmware
  2.2.0 copies).
- Test button: one real test per 10 s (else the last result), never a read
  sooner than the interval after the last one (/data included), except while
  the token is refused (no read runs then) or another gateway answers (reads
  go on, its functions are not offered): each test then reads the list, at
  most once per 10 s (review r3 M3, accepted). The token is accepted only on a
  2xx of the function list; it lifts a refused token and accepts a changed
  identity. The list it reads is the read of the session: taken at once
  (online right after the test, review r3 I5) and the planned read put off to
  the interval after it (`tick` is a no-op too early). During a 429 pause,
  neither Test nor "Request access" sends a request (stops aside).
- Refused token: only a 401/403 of GET /functions/ (the reads, the Test
  button). A 401/403 on a secondary route (scenes, socket, serial number,
  read back, command, stop) is "not read" / "refused on this route": spaced
  (scenes and socket doubling up to 1 h), never a block; a stop refused there
  is kept and sent again at the stop pace, not counted.
- Another token saved while running is tried (the refusal kept in /data is
  dropped): the 6-bit mark alone would take a new token for the refused one 1
  time in 64. Across a restart only the mark tells (a token changed while the
  container was stopped may then wait for the Test button, 1 time in 64).
- A stop clicked before the first `getConfig()` (container start) is refused,
  nothing sent: no token known yet (review r1, accepted with the /data gap).
- A cover close not answered: two quick retries (~250 ms after the click, no
  read), then sent again only after a read of the level, once per read (no
  quick retries then):
  100 or closer than at the click ends it; more open than at the click in two
  reads in a row (opened by hand) drops it; a level unknown at the click is
  never "changed elsewhere". A hand opening within the 250 ms of the click,
  or between a read and its send, cannot be seen (review r3, documented).
- A stop refused 4 times (423) or not applied after 4 answered sends stays
  kept and shown, without new sends, until a read shows it applied or a newer
  command (review r1 M6, for the forum post).
- Mutants: `scripts/mutants.mjs` (list and runner, one at a time, own temp
  directory, process group killed at the deadline).
- The gateway serves many clients (the app polls every 5 s): reads, commands
  (6 at most at once) and stops use their own connections; a stop never waits
  for a slot.
