# gladys-jung-home

[Gladys Assistant](https://gladysassistant.com) external integration for
**JUNG HOME** installations, through the local API of the JUNG HOME gateway:
lights, dimmers, roller shutters and blinds, sockets, room thermostats, rocker
buttons, sensors and JUNG HOME scenes. Local only (HTTPS and WebSocket of the
gateway, certificate pinned), live updates.

Unofficial, not affiliated with JUNG. **Never tested with a real device yet.**

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Access: the "Request access" button registers "Gladys" on the gateway; the
  user accepts it in the JUNG HOME app.
- Safety: turning off, stopping or closing a cover and the frost protection
  are never held back by an option, a pause, a read or a command in flight
  (a switch-off is kept until read back applied); sockets switch on only once
  declared safe; heating setpoints and JUNG HOME scenes are off by default.

## Development

```bash
npm install
gi test    # or: npm test (node --test --test-timeout=60000)
gi ci      # format, lint, tests on Node 24 and 22, Docker build, store validator
```

The tests run against the SDK's fake Gladys and a simulated gateway on
127.0.0.1 (HTTPS with a self-signed certificate, WebSocket), never the
network. See `CLAUDE.md` for the architecture and the rules, `TODO.md` for the
decisions and what comes next.

## License

Apache-2.0 (`LICENSE`). Protocol knowledge from
[junghome](https://github.com/ernetas/junghome) (MIT); see
`THIRD_PARTY_NOTICES.md`.
