# JUNG HOME

This integration connects your JUNG HOME installation to Gladys through the
local API of the JUNG HOME gateway (Bluetooth Mesh to IP). Everything stays on
your local network. Unofficial, not affiliated with JUNG (Albrecht JUNG GmbH &
Co. KG).

**Never tested with a real device yet**: the integration was written from the
protocol documentation of the `junghome` reference library (MIT) and tested
against a simulated gateway. Your feedback is welcome.

## What you get

In the **Discovery** tab:

- **Lights** (on/off) and **dimmers** (brightness);
- **Roller shutters and blinds**: open, close, stop, position (the slats are
  not driven yet);
- **Sockets**: their state, a "Turn off" button, and their power when the
  socket measures it; a socket declared safe becomes a switch;
- **Room thermostats**: ambient temperature, setpoint, a "Frost protection"
  button;
- **Rocker buttons**: a press up or down reaches your Gladys scenes;
- **Sensors**: temperature, illuminance, power;
- **JUNG HOME scenes**: a "Recall" button each.

The device ids are tied to the serial number of the gateway and to the id of
each function (`function:sn<serial>_<function>`): they do not change with an
update, but a function paired again in the JUNG HOME app becomes a new device.
On a firmware without the serial number, the MAC address replaces it.

## Configuration

1. Type the **IP address** of the gateway (shown in the JUNG HOME app or in
   your router) and **save**. Names in `.local` do not resolve in the
   container.
2. Click **Request access**. The integration first reads the certificate of
   the gateway and pins it (its SHA-256 fingerprint is shown), then sends one
   request as "Gladys".
3. In the JUNG HOME app: **Settings, Gateway, Access permissions, Open
   requests**, accept "Gladys" within 3 minutes. The token is saved by itself
   and the connection starts.
4. Add the devices you want from the **Discovery** tab.

The token is kept by Gladys in its database, never shown again, sent only to
the gateway at the address typed, and only on a connection whose certificate
is the pinned one.

### Certificate of the gateway

The gateway has a self-signed certificate. The integration accepts only the
pinned one: learnt on your first click of "Request access" or "Test the
connection", or typed in the **Certificate fingerprint** field. If another
certificate shows up (gateway replaced, card reinstalled, or another device at
this address), nothing is sent, not even a stop, and the status shows the
fingerprint seen. To trust it: click **Trust the new certificate** twice (the
second click within 2 minutes), or type this fingerprint in the
configuration.

## What always leaves, what is off by default

**Always leave**: turning off a light or a socket, stopping a cover, closing
a cover, the frost protection of a thermostat. No option, no 429 pause, no
read or command in flight, no serial number not read again yet holds them
back. They cancel the commands of the same target still waiting: nothing asked
before a stop leaves after it.

A stop does not leave only in these cases; it is then **kept** (the status
says it) and sent as soon as it can be:

- address or token missing or invalid, or token refused by the gateway: it leaves first as soon as a new
  token is saved or "Test the connection" succeeds;
- no pinned certificate, or certificate changed: it leaves once the
  certificate is pinned or recognized again;
- gateway unreachable, or the route refused (401/403) while the function list
  still accepts the token: it is sent again every 5 seconds, with no time
  limit (only a refusal of the function list is a refused token);
- before the configuration is first read from Gladys (container start): it
  is refused, nothing sent (the token is not known yet).

A switch-off or a frost protection stays kept, also in `/data` (a restart of
the container sends it first, as soon as the configuration is read), until a
read started after the answer of the gateway shows it applied. If the read
shows otherwise, it is sent again; only the sends the gateway answered count,
4 at most (after a restart of the container, it leaves once more at least).
After 4 refusals of the gateway (device
locked, wind alarm) or 4 sends not applied, it stays kept and shown, with no
new send, until a read shows it applied or a newer command. A newer command of the same target, taken by the gateway, replaces
it. A cover move (close, stop) is done once the gateway took it, and is never
replayed after a restart. A close that did not reach the gateway is first
tried again twice within about 250 ms of your click (still your click: the
cover opened by hand within those 250 ms may be closed over); after that, it
is sent again only after a read of the cover, once per read: closed or
closing, it is done; read more open than when you clicked twice in a row, it
was opened by hand meanwhile and the close is dropped. An opening by hand
between that read and the send (a few milliseconds) cannot be seen.

**Off by default**:

- **Sockets**: a socket may feed anything, and a "turn everything on" of a
  voice assistant or a scene reaches every switch. A socket is therefore only
  a state and a "Turn off" button until you declare it safe (field **Sockets
  declared safe**, with the `JUNG_FUNCTION` id shown in the Discovery); it
  then becomes a switch after a new Scan.
- **Heating setpoints**: read only until you allow them; then between 5 and
  30 °C (the bounds of the thermostat), in steps of 0.5 °C rounded down.
- **JUNG HOME scenes**: a scene may turn on any socket; their button does
  nothing until you allow them.

The option is read again right before sending: turned off while a command
waits, the command is refused.

## What a refused command says

A command (other than a stop) leaves within 3.5 seconds or not at all:
"nothing sent" says it never left. "Refused by the gateway" gives its reason
(device locked, wind alarm...). "Sent, without confirmation" says it left with
no answer; "not applied yet" that a read back does not show it yet. In these
last two cases, the device is read again after 5 and 20 seconds and its badge
says so meanwhile.

## Reads and live updates

With **live updates** (the default), the gateway sends each change over a
WebSocket; the full list is read again every 5 minutes. Without them, or when
the connection is lost, the list is read at the chosen **interval** (60 s by
default). Never faster: neither the Scan button (which publishes the
Discovery again without reading), nor the "Test the connection" button (which
then says when it can test again), nor a restart of the container reads before
the interval after the last read; a new address or a new token saved reads at
once. A read made by the Test button is the read of the integration: its list
is used at once (connected right after a successful test) and the next read
comes at the interval after it. While the token is refused (no read runs then)
or another gateway answers (the reads go on, its functions are not offered),
the Test button tries at once, once per 10 seconds, each try reading the
function list. During a pause asked by the gateway (429), neither the Test
button nor "Request access" sends a request; only the stops leave.

A press of a rocker is seen live only. The 2.2.0 firmware of the buttons sends
each press twice, about 1 s apart: a second press of the same button within
1.2 s is ignored.

## Known limits

- The slats of blinds, the colour temperature and awnings (reversed
  direction) are not driven yet.
- The energy counter of the sockets (only on an experimental route of the
  gateway) is not read.
- A long press and a double press are not told apart.
- Access by the network key password is not offered: only by approval in the
  JUNG HOME app.

## Troubleshooting

- **"The certificate of the gateway changed"**: see above.
- **"The gateway refused the token"**: access was withdrawn in the app; click
  "Request access" again.
- **"Another gateway answers at this address"**: the serial number read is no
  longer the one learnt; "Test the connection" accepts the new gateway.
- **"/data is unreadable"**: the integration works, but learns and keeps
  nothing (certificate, identity, stops); type the fingerprint of the
  certificate in the configuration.
