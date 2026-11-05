# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
It bridges a JUNG HOME gateway through its local REST API and WebSocket
(protocol from the junghome reference, MIT). Runtime dependencies: the SDK and
`ws`.

## Commands

```bash
npm install
gi test                                   # or npm test (node --test --test-timeout=60000)
node --test test/commands.test.js         # one file (through memcap on the dev VM)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run cover                             # cover.png (800x534), plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/app.js                        JungHomeApp: lifecycle, reads, live, commands, stops, buttons
src/gateway.js                    REST client on a pinned TLS socket, answers, registration
src/live.js                       wss://<gateway>/ws on the pinned socket, frames (bounded)
src/model.js                      functions -> Gladys devices, readers, writers (pure)
src/store.js                      /data: pins, identity, refused-token mark, pause, kept stops
src/publisher.js                  states within 300/min, rocker presses as events
src/config.js                     DEFAULT_CONFIG (mirrors the manifest) + normalization
src/i18n.js                       texts in English and French
test/helpers/fakeGateway.js       simulated gateway (HTTPS + WebSocket) on 127.0.0.1
test/kit/                         parts of gladys-testkit (clocks, certificates)
```

## Safety rules of this integration

- **Stops are never held back**: switch off (lights, sockets, brightness 0),
  cover stop and close, frost protection. Not by an option, a bound, a 429
  pause, a read or a command in flight, a full queue, an identity not read
  again, nor a slow /data (never awaited on their path). They wait only for
  what the token needs (a token, its acceptance, a pinned certificate) and are
  then kept and sent first. A switch-off or a frost protection stays kept (in
  /data) until a read started after the gateway's answer shows it applied; at
  most 4 answered sends per run; a newer command taken by the gateway lifts it.
- **Nothing sent before a stop leaves after it**: every command checks the
  stop count of its target right before its first byte (`beforeSend`).
- **A read started before a command never applies to its target after it**
  (marks given when a request leaves).
- Other commands leave within 3.5 s or not at all, every check (option, token,
  pause, identity) done again in `beforeSend`.
- Sockets are never a switch unless declared safe; heating setpoints and
  JUNG HOME scenes are off by default; setpoints bounded 5 to 30 °C.
- The token goes only to the configured address, on a connection whose
  certificate is the pinned one, checked before the first byte; never logged,
  never in /data, a status nor an error. A changed certificate is never
  learnt alone.
- A refused token is kept (6-bit salted mark in /data), never tried again
  until a new token or the Test button.
- /data unreadable is never taken for empty (nothing learnt or written over it).
- Clocks: monotonic for every decision; wall time only for /data.

## Rules

- **External ids are forever**: `function:<sn serial | mac MAC>_<function id>`
  and `scene:<...>_<scene id>`, built with `gladys.externalIds`. Changing one
  orphans the user's devices. The same goes for the manifest keys and the
  feature keys (`on`, `brightness`, `state`, `position`, `setpoint`, `frost`,
  `off`, `press_up`, `press_down`, `q<suffix>`, `recall`).
- **A device published again never loses a feature** (`app.publishDevices`).
- **The container rootfs is read-only**: write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  that package.json, the lock and the manifest agree.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs in sync with
  the code.
- **Tests never touch the network** beyond 127.0.0.1; every wait is bounded
  (a test fails, it never hangs).
