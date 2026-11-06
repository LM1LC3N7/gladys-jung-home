# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-06

### Added

- JUNG HOME gateway over its local REST API and WebSocket: lights, dimmers,
  roller shutters and blinds (position, open, close, stop), sockets (state,
  "Turn off", power), room thermostats (ambient temperature, setpoint, frost
  protection), rocker presses, sensors (temperature, illuminance, power) and
  JUNG HOME scenes.
- "Request access" button: registers "Gladys" on the gateway, accepted in the
  JUNG HOME app; the token is saved by itself.
- Certificate of the gateway pinned on a click (or typed); a changed one stops
  everything until trusted in two clicks or typed.
- Stops (turn off, cover stop and close, frost protection) never held back; a
  switch-off or a frost protection kept in /data until read back applied.
- Sockets switched on only once declared safe; heating setpoints (5 to 30 °C)
  and JUNG HOME scenes off by default.

[Unreleased]: https://github.com/LM1LC3N7/gladys-jung-home/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-jung-home/releases/tag/v0.1.1
