# signalk-portainer

[![SignalK Plugin CI](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml)

A Signal K server plugin that manages [Portainer CE](https://www.portainer.io/)
over its HTTP API — containers, stacks, images, volumes and networks — and
publishes container health into the Signal K data model.

Portainer may run on the same machine as the Signal K server or on any other
reachable host, and several Portainer instances may be configured at once (boat
and shore, for example). Each has its own scheme, host, port, TLS settings,
credentials and environment.

The plugin talks to Portainer server-side, so no token reaches the browser and
there is no CORS, mixed-content or self-signed-certificate interstitial to work
around. It exposes a small REST facade under `/plugins/signalk-portainer/api/*`,
protected by Signal K's own authentication, and on top of that:

- an **embedded panel** in the Signal K admin UI for day-to-day container work,
  including a log viewer and a terminal;
- **Signal K deltas** publishing container state under `system.docker.<instance>.*`;
- **watchdog notifications** raising a Signal K alarm when a container that
  should be running is not;
- **PUT handlers** so any Signal K client can start, stop or restart a container.

## Requirements

- Signal K server running on Node.js 22 or newer.
- Portainer CE 2.x, reachable from the Signal K server.

Node 20 platforms — Venus OS / Cerbo GX among them — are out of scope.

## Installing

Install from **Appstore → Available** in the Signal K admin UI, like any other
plugin, then restart Signal K and enable **Portainer** under Server → Plugin
Config.

To install from a checkout instead:

```bash
npm install && npm run build && npm pack
cd ~/.signalk && npm install /path/to/signalk-portainer-0.1.0.tgz
```

## Configuration

Everything is configured from the plugin's own page in the Signal K admin UI.

### 1. Add an instance

Give it a `name` — it is path-safe, and renaming it moves that instance's Signal
K paths — then the `host` and `port` Portainer answers on (`https` and `9443` by
default). Add several entries for several Portainers; the panel then shows an
instance selector.

### 2. Give it a credential

Either an **API access token** from Portainer → My account → Access tokens
(these start with `ptr_`), or a username and password. Either way the credential
stays on the server; the browser never receives one.

### 3. Deal with the certificate

Portainer's default certificate is self-signed, so pick one of:

- paste its CA into **CA certificate (PEM)** — the option to prefer;
- set **TLS servername override** when connecting by IP to a certificate issued
  for a hostname;
- or turn **Verify TLS certificate** off for that instance, if you cannot supply
  a CA.

### 4. Pick an environment

By id or by name. Leave it empty when Portainer has exactly one environment and
the plugin selects it.

### 5. Decide what the plugin may do

Three independent switches, each enforced server-side however the panel behaves:

| Setting                                      | Default | What it allows                                                     |
| -------------------------------------------- | ------- | ------------------------------------------------------------------ |
| Allow Signal K PUT control                   | on      | any mutation at all — lifecycle, stacks, the console               |
| Allow destructive operations                 | **off** | removing containers and volumes, deleting stacks, pruning          |
| Allow managing the Signal K container itself | **off** | acting on the container Signal K runs in, which can stop this page |

### 6. Choose what to publish

Deltas are `off`, `health` or `full`, on a configurable poll interval. Add a
watchdog entry for any container whose absence should raise a Signal K alarm.

## Using the panel

The plugin adds a **Portainer** panel to the Signal K admin UI with an instance
selector and tables for environments, containers, stacks, images, volumes and
networks — plus services and nodes when the environment is a Swarm. It polls
every 10 seconds, and shows facade errors with their hint rather than an empty
table.

### Containers

Start, stop, restart, kill and remove, each behind the guards described below.
Everything except starting asks for confirmation in a dialog that names the
container and says what the action does to it. The container Signal K itself
runs in is labelled as such and its buttons are disabled. A button the
configuration does not allow is disabled, with the setting to change as its
tooltip, rather than left to fail on click.

### Logs

Open the log viewer from any container row, a stopped one included. Choose how
many lines to start from and how far back to reach, turn timestamps on, and turn
Follow on to watch it live. stderr is coloured apart from ordinary output and
can be shown on its own, and what is on screen can be downloaded as a text file.
The buffer holds the last 5000 lines, and the view follows the tail only while
you are already at the bottom of it.

Streaming uses Server-Sent Events, so it inherits the Signal K session cookie
and reconnects on its own. A container started without a TTY has its stdout and
stderr demultiplexed, so each line arrives labelled with the stream it came
from; a container started _with_ a TTY has no such separation — Docker merges
stderr into stdout before the plugin sees it — so every line from one of those
is labelled `stdout`.

At most 3 streams may be open per container and 8 in total, so forgotten browser
tabs cannot exhaust file descriptors on a small machine.

### Console

**Console** opens a shell in a dialog — `/bin/sh`, `/bin/bash` or `/bin/ash`,
picked before it starts. The button is disabled, with the reason as its tooltip,
for a container that is not running, for the Signal K container, and while
control is off. It is absent altogether on a Signal K server that cannot serve a
plugin WebSocket, in which case `GET /control` says so.

The terminal takes the keyboard once the shell is connected, including Tab, and
Escape belongs to the shell rather than the dialog — so **Ctrl+]**, the same
break-out key `telnet` and `docker attach` use, moves focus back to Close.

At most 3 shells may be open at once, 2 per container, and one nobody has
touched for 15 minutes is closed. Closing the dialog, switching instance or
stopping the plugin closes the shell.

The terminal is [xterm.js](https://xtermjs.org/), loaded in its own chunk the
first time somebody opens a shell, so a panel that never does never downloads
it.

### Stacks

Each row offers what applies to it: a running stack is stopped and a stopped one
started, never both, and Redeploy appears only for a stack that has a
repository. **Edit** opens the compose file and the stack's environment
variables side by side, with toggles for pruning and re-pulling, and a Deploy
that stays disabled until something changes. **New stack** creates one from a
file or from a repository. Deleting asks first, in a dialog that names the stack
and offers its volumes as a separate, unticked choice. A failed deploy leaves
the editor open with the file still in it.

A stack deployed from a repository is shown read-only: deploying a file over it
would detach it from git, so change the file in git and redeploy instead.
Updating a file-based stack drops any auto-update Portainer had on it, and the
answer says so. `prune` is always sent explicitly and defaults to off.

## Signal K integration

### Delta paths

```text
system.docker.<instance>.status.reachable            boolean
system.docker.<instance>.status.version              string   (Docker version)
system.docker.<instance>.status.containersRunning    number
system.docker.<instance>.status.containersTotal      number
system.docker.<instance>.containers.<key>.state      running | exited | paused | …
system.docker.<instance>.containers.<key>.health     healthy | unhealthy | starting
system.docker.<instance>.containers.<key>.image      string   (full level)
system.docker.<instance>.containers.<key>.name       string   (full level)
system.docker.<instance>.containers.<key>.id         string   (full level)
```

The prefix `system.docker` is configurable. Paths carry Signal K metadata, so
dashboards render labelled values rather than bare numbers.

How much is published is a choice:

| Level    | Publishes                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------- |
| `off`    | nothing — no polling at all, unless a watchdog is configured; the facade and the panel still work |
| `health` | instance reachability and version, running/total counts, and each container's state and health    |
| `full`   | the above plus each container's image, name and short id                                          |

`health` is the default: it is what a dashboard and the watchdog need, without
carrying an image name and a container id for every container through the delta
stream on every poll.

`<key>` prefers the compose project and service (`signalk_influxdb`), then the
Swarm service name, then the container name, then the short id — so `docker
compose up` recreating a container does not move its paths and take every
dashboard gauge with it. Two containers that would normalise to the same key get
the short id appended.

A container that disappears has its paths published once as `null` and then
dropped, so a dashboard clears instead of showing a gauge for something that no
longer exists. Stopping the plugin clears them the same way. An unreachable
instance publishes `status.reachable: false` and says nothing about containers —
a failed poll knows nothing about the environment, and "0 running" would read as
every container being down.

### Notifications

```text
notifications.system.docker.<instance>.status               instance reachability
notifications.system.docker.<instance>.containers.<key>     a watched container
```

List the containers that must be running under **Watchdog**, and one that is not
raises a standard Signal K notification — so the chartplotter beeps at 3am
instead of the crew finding a gap in the track next morning. It is cleared
automatically when the container comes back. An unreachable Portainer raises one
alarm of its own rather than one per container: a network blip is not evidence
that anything stopped.

Alarms are raised on the transition, not on every poll. Nothing is published
here unless the watchdog lists something. A watch names its container however
you know it: the container name, the normalised path key, a compose service key,
or an id prefix.

### PUT control

Writing `running`, `stopped` or `restart` to a container's
`…containers.<key>.state` path starts, stops or restarts it, so a dashboard
button or an automation rule can do what the panel does. PUT handlers are
registered only when **Allow Signal K PUT control** is set, are subject to the
same self-protection as everything else, and answer `PENDING` until Docker
finishes.

## REST API

The facade lives under `/plugins/signalk-portainer/api/`, is authenticated by
Signal K, and is refused when the browser says the request came from another
site. Almost every route takes `?instance=<name>`, defaulting to the first
enabled instance (`/instances` and `/health` span them all, and
`/console/resize` takes its instance from the session):

| Route                                      | Returns                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `GET /instances`                           | configured instances and which is default                                        |
| `GET /health`                              | reachability, version and capabilities per instance                              |
| `GET /environments`                        | environments with health, and which is selected                                  |
| `GET /capabilities`                        | swarm support, swarm id, Docker and Portainer versions                           |
| `GET /containers`                          | container list (`?all=true` to include stopped)                                  |
| `GET /containers/:id`                      | container inspect                                                                |
| `GET /containers/:id/logs`                 | log lines (`?tail=` `?since=` `?timestamps=`)                                    |
| `GET /containers/:id/logs/stream`          | the same, live, as Server-Sent Events                                            |
| `GET /stacks`                              | stacks belonging to this environment                                             |
| `GET /stacks/:id/file`                     | the stack's compose file                                                         |
| `POST /stacks`                             | create from `content` or from `repositoryUrl`                                    |
| `POST /stacks/:id/:action`                 | `start` · `stop` · `redeploy` (`?prune=` needs destructive, `?pullImage=`)       |
| `PUT /stacks/:id`                          | deploy a new compose file and environment                                        |
| `DELETE /stacks/:id`                       | delete — Portainer CE cannot remove a stack's volumes with it                    |
| `GET /images` `/volumes` `/networks` `/df` | inventory and disk usage                                                         |
| `GET /swarm/services` `/swarm/nodes`       | 404 unless the daemon is a swarm                                                 |
| `GET /control`                             | what the UI may offer, and whether self-protection is active                     |
| `POST /containers/:id/:action`             | `start` · `stop` · `restart` · `kill` · `pause` · `unpause`                      |
| `POST /containers/:id/exec`                | a console ticket, redeemed on `ws://…/plugins/signalk-portainer/console?ticket=` |
| `POST /console/resize`                     | `{ session, cols, rows }` — the size of an open console's terminal               |
| `DELETE /containers/:id`                   | remove (`?force=` `?removeVolumes=`)                                             |

`tail` bounds the history a log request starts from — 200 lines by default, 5000
at most.

The console is a WebSocket relay rather than a proxy. Signal K hands a plugin
the raw WebSocket upgrade to authenticate itself, and a session cookie is the
wrong thing to trust there, because upgrades are not subject to CORS. So an
admin-authenticated POST creates the exec instance and returns a **single-use
ticket**, valid for 30 seconds and bound to exactly that shell; the socket
presents the ticket, and a socket without one is closed. The exec command is a
list of arguments, never a string to be split, so nothing a request contains
reaches a shell as text.

## Safety guards

Three independent checks, each enforced server-side regardless of what the UI
offers:

- **Control disabled** — every mutating route returns 403 unless **Allow Signal
  K PUT control** is set.
- **Destructive disabled** — removal additionally requires **Allow destructive
  operations**. `removeVolumes` defaults to false, so a container's data is
  never destroyed by implication.
- **Self-protection** — the plugin identifies the container it runs in and
  refuses to start, stop, restart, kill or remove it, and refuses to stop,
  update, redeploy or delete the _stack_ that contains it. Stopping that
  container stops Signal K, the admin UI and the plugin issuing the request,
  leaving no way back except a shell on the host. Override with **Allow managing
  the Signal K container itself**.

The stack check reads the compose project and swarm namespace labels off the
containers themselves, and counts a Signal K container that is currently
stopped: down is not gone.

Identification reads `/proc/self/cgroup`, falls back to `/proc/self/mountinfo`
(cgroup v2 often hides the id), then to the hostname, which Docker defaults to
the short container id. If the plugin is containerised but cannot identify
itself — a custom `--hostname` under cgroup v2 with no bind mounts — it says so
in `GET /control` rather than implying a protection it cannot provide.

Docker accepts a container name wherever an id goes, so a reference that is not
already our id is inspected and the guard applied to the canonical id Docker
reports. A reference that cannot be resolved is never mutated: not knowing what
it points at is not the same as knowing it is safe.

Every mutation the guards accept, and every refusal, is logged through
`app.debug` — enable the plugin on the server's Log page to keep the trail.

## Development

```bash
npm install        # install dependencies
npm run lint       # eslint
npm run format:check
npm test           # unit tests, no network required, 80% coverage enforced
npm run build      # emits dist/
```

These same commands run in CI via the Signal K project's shared
[`plugin-ci`](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml)
reusable workflow, on Node 22 and 24 across Linux x64, Linux arm64, macOS and
Windows. It additionally validates the plugin entry point and schema, the
start/stop/restart lifecycle, deprecated server API usage, npm pack completeness
and App Store compatibility.

Background reading:

- [`docs/plan.md`](docs/plan.md) — architecture, configuration schema, Signal K
  integration and the design decisions behind them.
- [`docs/portainer-api.md`](docs/portainer-api.md) — reference of the Portainer
  CE 2.x API surface the plugin uses.
- [`docs/signalk-webapp.md`](docs/signalk-webapp.md) — the Signal K embedded
  webapp contract: Module Federation, the fixed `./AppPanel` name and React
  singleton sharing.
- [`CHANGELOG.md`](CHANGELOG.md) — what is in each release.

## License

MIT — see [LICENSE](LICENSE).
