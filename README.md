# signalk-portainer

[![SignalK Plugin CI](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml)

A Signal K server plugin that manages [Portainer CE](https://www.portainer.io/)
over its HTTP API — containers, stacks, images, volumes and networks — and
publishes container health into the Signal K data model.

Portainer may run on the same machine as the Signal K server or on any other
reachable host, and several Portainer instances may be configured at once
(boat and shore, for example). Each is configured with its own scheme, host,
port, TLS settings, credentials and environment.

> **Status: M6b — the console in the panel.** The last milestone in
> [`docs/plan.md`](docs/plan.md): a terminal on the Containers tab, on top of
> the relay M6a built. CI installs the plugin into a real Signal K server and
> checks that it loads and starts, but nothing here has been driven by a person
> through the admin UI or pointed at a real Portainer; see [What has and has not
> been verified](#what-has-and-has-not-been-verified).

## Documents

- [`docs/plan.md`](docs/plan.md) — architecture, configuration schema, Signal K
  integration, safety rails, milestones, and the settled design decisions.
- [`docs/portainer-api.md`](docs/portainer-api.md) — researched reference of the
  Portainer CE 2.x API surface the plugin uses.
- [`docs/signalk-webapp.md`](docs/signalk-webapp.md) — the Signal K embedded
  webapp contract: Module Federation, the fixed `./AppPanel` name, React
  singleton sharing, and why cookie auth makes the facade design correct.
- [`CHANGELOG.md`](CHANGELOG.md) — what is in each release.

## In one paragraph

The plugin talks to Portainer server-side (never from the browser: no CORS, no
token in the client, no self-signed-cert interstitial, no mixed content) and
exposes its own small REST facade under `/plugins/signalk-portainer/api/*`,
protected by Signal K's own authentication. On top of that facade sit an
embedded webapp for day-to-day container work, a delta poller turning container
state into Signal K paths under `system.docker.<instance>.*`, watchdog
notifications raising a Signal K alarm when a container that should be running
is not, and PUT handlers so any Signal K client can start or stop a container.

## Installing it

> Not yet published to npm, and not yet run against a real Portainer. Read
> [What has and has not been verified](#what-has-and-has-not-been-verified)
> first, and start with a Portainer whose containers you can afford to lose.

Needs Signal K server on Node.js 22 or newer. Once published, it installs from
**Appstore → Available** in the Signal K admin UI, like any other plugin. To
try it before then, from a checkout:

```bash
npm install && npm run build && npm pack
cd ~/.signalk && npm install /path/to/signalk-portainer-0.1.0.tgz
```

Then restart Signal K and enable **Portainer** under Server → Plugin Config.

## Setting it up

Everything is configured from the plugin's own page in the admin UI. The
essentials:

1. **Add an instance.** Give it a `name` — it is path-safe and renaming it
   moves that instance's Signal K paths — then the `host` and `port` Portainer
   answers on (`https` and `9443` by default). Add several for several
   Portainers; the panel gets an instance selector.

2. **Give it a credential.** Either an **API access token** from Portainer →
   My account → Access tokens (starts with `ptr_`), or a username and
   password. Whichever you choose stays on the server: the browser never
   receives one.

3. **Deal with the certificate.** Portainer's default certificate is
   self-signed, so one of:
   - paste its CA into **CA certificate (PEM)** — the option to prefer;
   - set **TLS servername override** when connecting by IP to a certificate
     issued for a hostname;
   - or turn **Verify TLS certificate** off, per instance, if you cannot
     supply a CA.

4. **Pick an environment**, by id or by name. Leave it empty when Portainer has
   exactly one and the plugin will select it.

5. **Decide what it may do.** Three independent switches, each enforced
   server-side however the panel behaves:

   | Setting                                      | Default | What it allows                                                     |
   | -------------------------------------------- | ------- | ------------------------------------------------------------------ |
   | Allow Signal K PUT control                   | on      | any mutation at all — lifecycle, stacks, the console               |
   | Allow destructive operations                 | **off** | removing containers and volumes, deleting stacks, pruning          |
   | Allow managing the Signal K container itself | **off** | acting on the container Signal K runs in, which can stop this page |

6. **Choose what to publish.** Deltas are off, health or full, on a poll
   interval. Add a watchdog entry for any container whose absence
   should raise a Signal K alarm.

## What works today (M6b)

- Configure one or more Portainer instances (protocol, host, port, base path,
  TLS, API token or username/password, environment).
- The plugin resolves each instance's Docker environment, probes Swarm support,
  and reports connected versions in its Signal K plugin status.
- An **embedded panel in the Signal K admin UI** with an instance selector and
  tables for environments, containers, stacks, images, volumes and networks —
  plus services and nodes when the environment is a Swarm. It polls every 10s
  and surfaces facade errors with their hint rather than an empty table.
- **Container lifecycle** — start, stop, restart, kill and remove, each behind
  the guards below, from the API and from buttons on the Containers tab.
  Everything except starting asks first, in a dialog that names the container
  and says what the action does to it. The container running Signal K is
  labelled as such and its buttons are disabled. A button the configuration
  does not allow is disabled with the setting to change as its tooltip, rather
  than left to fail as a 403 on click.
- **Signal K deltas** — container state published under
  `system.docker.<instance>.*` on a configurable interval, with metadata so
  dashboards render labelled values rather than bare numbers. How much is
  published is a choice, not a switch:

  | Level    | Publishes                                                                                         |
  | -------- | ------------------------------------------------------------------------------------------------- |
  | `off`    | nothing — no polling at all, unless a watchdog is configured; the facade and the panel still work |
  | `health` | instance reachability and version, running/total counts, and each container's state and health    |
  | `full`   | the above plus each container's image, name and short id                                          |

  `health` is the default: it is what a dashboard and the watchdog need, without
  carrying an image name and a container id for every container through the
  delta stream and the logs on every poll.

- **Watchdog alarms** — list the containers that must be running, and one that
  is not raises a standard Signal K notification, so the chartplotter beeps at
  3am instead of the crew finding a gap in the track next morning. Cleared
  automatically when the container comes back. An unreachable Portainer raises
  one alarm of its own rather than one per container: a network blip is not
  evidence that anything stopped.

- **PUT control** — writing `running`, `stopped` or `restart` to a container's
  `…containers.<key>.state` path starts, stops or restarts it, so a dashboard
  button or an automation rule can do what the panel does. Registered only when
  `allowPutControl` is set, subject to the same self-protection, and answered
  `PENDING` until Docker actually finishes.

- **A log viewer in the panel**, opened from any container row — a stopped one
  included, since the logs of something that exited are the reason to look at
  them. Choose how many lines to start from and how far back to reach, turn
  timestamps on, and turn Follow on to watch it live. stderr is coloured apart
  from ordinary output and can be shown on its own, and what is on screen can
  be downloaded as a text file. The buffer holds the last 5000 lines, so a
  container writing steadily cannot grow the page without bound; the view
  follows the tail only while the operator is already at the bottom of it.
  Every way of leaving — closing the viewer, turning Follow off, switching
  instance, or the container stopping — closes the stream, because one left
  open holds a server slot until the cap refuses the next viewer.

- **Container logs**, one-shot or live. A container started without a TTY has
  its stdout and stderr multiplexed into one framed stream; the plugin demuxes
  it, so every line arrives labelled with the stream it came from and no framing
  bytes ever reach the browser. A container started _with_ a TTY has no framing
  and no separation — Docker merges stderr into stdout before the plugin ever
  sees it — so every line from one of those is labelled `stdout`, whichever
  stream the process wrote to.
  Streaming is Server-Sent Events rather than a WebSocket: it inherits the
  Signal K session cookie, reconnects on its own, and needs no second auth path.
  A quiet stream sends a comment frame every 20 seconds so proxies and NAT
  tables do not reap it, and closing the tab ends the upstream request rather
  than leaving it open.
  `tail` bounds the history a request starts from — 200 lines by default, 5000
  at most — but not a follow stream, which then runs for as long as the browser
  keeps it open. What bounds those is the concurrency ceiling: at most 3 streams
  per container and 8 in total, so a few forgotten browser tabs cannot exhaust a
  Raspberry Pi's file descriptors.

- **A container console**, as a WebSocket relay rather than a proxy. Signal K
  authenticates the plugin's REST routes but hands a plugin the raw WebSocket
  upgrade to authenticate itself — and a cookie is the wrong thing to trust
  there, because upgrades are not subject to CORS, so any page the operator
  visits can open one to their own server and have the browser attach the
  session. So the authorisation happens where it can: an admin-authenticated
  POST creates the exec instance and returns a **single-use ticket**, valid for
  30 seconds and bound to exactly that shell, and the socket presents the
  ticket. A socket without one is closed knowing nothing else.

  The command is a list of arguments, never a string to be split, so nothing a
  request contains reaches a shell as text. A shell in the Signal K container
  is refused like every other way of stopping it. At most 3 shells are open at
  once, 2 per container, and one nobody has touched for 15 minutes is closed —
  a forgotten shell holds a process in the container as well as two sockets.
  Both sockets always end together, whichever end goes first, and the plugin
  stopping ends all of them.

  Requires a Signal K server that lets a plugin serve a WebSocket. On an older
  one the console is absent and `GET /control` says why, rather than offering a
  button that cannot work.

- **A terminal on the Containers tab.** Console opens a shell in a dialog:
  `/bin/sh`, `/bin/bash` or `/bin/ash`, picked before it starts. The button is
  disabled with the reason as its tooltip for a container that is not running,
  for the Signal K container, and while control is off — and it is absent
  altogether on a server that cannot serve a console, since that is not
  something an operator can change.

  The terminal takes the keyboard once the shell is connected, including Tab,
  and Escape belongs to the shell rather than the dialog — so **Ctrl+]**, the
  break-out key `telnet` and `docker attach` already use, moves focus back to
  Close. Without it a shell reached by keyboard could not be left by one.

  The browser is the only end that knows how big the terminal is, so it says
  so: the POST that mints the ticket also returns a session handle, and
  `POST /console/resize` tells Docker the size, on connect and whenever the
  window changes shape. The handle travels only in request bodies, never in a
  URL — unlike the ticket, which a proxy log would keep.

  Opening a shell is three awaits — the POST, the terminal's own chunk, and the
  socket — and the dialog can close during any of them. Each step checks
  whether it is still wanted and closes what it built when it is not: a shell
  left behind holds a process in the container and one of the three console
  slots. Switching instance closes the shell rather than relaying to a
  container nobody is looking at. Every close code says something useful — a
  spent ticket, too many consoles, an unreachable Portainer, the idle timeout —
  rather than a number.

  The terminal is [xterm.js](https://xtermjs.org/), which is 83 KB gzipped
  against the panel's own 18 KB, so it is **not** in the bundle the admin UI
  loads to show a table of containers. It arrives in its own chunk the first
  time somebody opens a shell, and a panel that never does never downloads it.
  The alternative considered was rendering the shell's output into a `<pre>`;
  it was rejected because a pty emits cursor movement, colour and erase
  sequences from the first prompt onwards, and anything full-screen — `top`,
  `vi`, `less` — would render as garbage.

- **A stacks editor in the panel.** Each row offers what applies to it: a
  running stack is stopped and a stopped one started, never both; Redeploy
  appears only for a stack that has a repository. Edit opens the compose file
  and the stack's environment variables side by side, with toggles for pruning
  and re-pulling, and a Deploy that stays disabled until something actually
  changes. A stack deployed from a repository is shown read-only — deploying a
  file over it would detach it from git, which the server refuses — and New
  stack creates one from a file or from a repository. Deleting asks first, in a
  dialog that names the stack and offers its volumes as a separate, unticked
  choice. A failed deploy leaves the editor open with the file still in it,
  because an error message asking the operator to try again should not also
  throw away what they wrote.

- **Stack control** — start, stop, update, redeploy, create and delete, behind
  the same guards container lifecycle uses. An update sends the compose file
  and, unless the caller says otherwise, the environment the stack already had:
  editing a file is not a statement about its variables. A stack deployed from
  a repository is not updated this way at all — Portainer's update handler
  detaches it from git and clears its auto-update settings, so the stack quietly
  stops being what the repository describes; change the file in git and
  redeploy. Updating a file-based stack drops any auto-update Portainer had on
  it, which no field in the request can prevent, so the answer says so. `prune` is always sent
  explicitly and defaults to off, so a file that lost a service by accident does
  not take the service with it. A redeploy pulls from the stack's own repository
  and is refused for a stack that has none, rather than passed on to Portainer
  to fail on a field the operator never filled in. Creating picks the swarm or
  standalone route from the environment rather than asking the caller.

- A REST facade under `/plugins/signalk-portainer/api/`, authenticated by
  Signal K, and refused when the browser says the request came from another
  site — a mutating route with no body is a CORS "simple request", so the
  cookie alone is not enough to authorise one. Almost every route takes
  `?instance=<name>`, defaulting to the first enabled instance (`/instances`
  and `/health` span them all, and `/console/resize` takes its instance from
  the session):

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

### Guards on the mutating routes

Three independent checks, each enforced server-side regardless of what the UI
offers:

- **Control disabled** — every mutating route returns 403 unless
  `allowPutControl` is set.
- **Destructive disabled** — removal additionally requires `allowDestructive`.
  `removeVolumes` defaults to false, so a container's data is never destroyed
  by implication.
- **Self-protection** — the plugin identifies the container it runs in and
  refuses to start, stop, restart, kill or remove it — and refuses to stop,
  update, redeploy or delete the _stack_ that contains it, which is the same
  outcome reached by naming something one level up. The stack check reads the
  compose project and swarm namespace labels off the containers themselves, and
  counts a Signal K that is currently stopped: down is not gone. Stopping that container
  stops Signal K, the admin UI and the plugin issuing the request, leaving no
  way back except a shell on the host. Override with `allowSelfManagement`.

Identification reads `/proc/self/cgroup`, falls back to `/proc/self/mountinfo`
(cgroup v2 often hides the id), then to the hostname, which Docker defaults to
the short container id. If the plugin is containerised but cannot identify
itself — a custom `--hostname` under cgroup v2 with no bind mounts — it says so
in `GET /control` rather than implying a protection it cannot provide.

Docker accepts a container name wherever an id goes, so a reference that is not
already our id is inspected and the guard is applied to the canonical id Docker
reports — asking for the Signal K container by name is refused just the same. A
reference that cannot be resolved is never mutated: not knowing what it points
at is not the same as knowing it is safe.

Every mutation the guards accept, and every refusal, is logged through
`app.debug` — enable the plugin in the server's Log page to keep the trail.

Requires Node.js 22 or newer — the versions CI actually verifies.

> Declaring Node 22 means Venus OS / Cerbo GX, which ships Node 20, is out of
> scope. The Signal K shared workflow reads `engines.node` and skips its
> ES2023 compatibility check once the declared major is 22 or above, so that
> compatibility is no longer checked either.

```bash
npm install        # install dependencies
npm run lint       # eslint
npm run format:check
npm test           # 739 unit tests, no network required, 80% coverage enforced
npm run build      # emits dist/
```

These same commands run in CI via the Signal K project's shared
[`plugin-ci`](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml)
reusable workflow, on Node 22 and 24 across Linux x64, Linux arm64, macOS and
Windows. It additionally validates the plugin entry point and schema,
the start/stop/restart lifecycle, deprecated server API usage, npm pack
completeness and App Store compatibility. An armv7 (Cerbo GX / Venus OS) job is
available on demand from the Actions UI.

## Design decisions

|                         | Decision                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Namespace**           | `system.docker.<instance>.*`, prefix configurable, with Signal K metadata (units, display names) so dashboards render it properly.                                          |
| **Multiple Portainers** | Configured as an array from v1 — adding a second instance is configuration, not a migration.                                                                                |
| **Swarm**               | Auto-detected from `docker/info`; swarm views appear only when the daemon is in a swarm. No toggle.                                                                         |
| **Delta keys**          | Compose service identity first (`project_service`), then stack, then container name, then short id — so `docker compose up` recreating a container does not move its paths. |

Rationale for each is in [`docs/plan.md` §10](docs/plan.md#10-decisions).

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

`<key>` prefers the compose project and service (`signalk_influxdb`), then the
Swarm service name, then the container name, then the short id — so `docker
compose up` recreating a container does not move its paths and take every
dashboard gauge with it. Two containers that would normalise to the same key
get the short id appended rather than sharing a path and flickering between
each other.

### Notifications

```text
notifications.system.docker.<instance>.status               instance reachability
notifications.system.docker.<instance>.containers.<key>     a watched container
```

Raised on the transition, not on every poll — Signal K keeps the last value for
clients that connect later, and re-sending an unchanged alarm every 30 seconds
is noise. A watch names its container however the operator knows it: the
container name, the normalised path key, a compose service key, or an id prefix.

Nothing is published here unless `watchdog` lists something. An alarm the
operator did not ask for teaches them to ignore the channel.

A container that disappears has its paths published once as `null` and then
dropped, so a dashboard clears instead of showing a gauge for something that no
longer exists. Stopping the plugin clears them the same way. An unreachable
instance publishes `status.reachable: false` and says nothing about containers —
a failed poll knows nothing about the environment, and "0 running" would read as
every container being down.

## What has and has not been verified

Worth being explicit about, because the milestone plan is now complete and it
would be easy to read that as "finished".

**Verified.** 739 unit tests, no network required, covering every module in
`src/`. Portainer and Docker are answered by an intercepting HTTP agent, and the
tests assert what the plugin _sent_ as well as what it did with the reply, so
the request shapes match Portainer's documented API. The Signal K plugin
contract — entry point, schema, start/stop lifecycle, no deprecated server APIs
— is checked by Signal K's own CI workflow on Node 22 and 24 across Linux x64,
Linux arm64, macOS and Windows, which also installs the plugin into a real
Signal K server and confirms it loads and starts.

**Not verified.** None of it has been run against a real Portainer or driven by
a person through a real admin UI. The CI check above is a narrow one — it proves
the plugin loads, starts and stops inside a real Signal K server, not that any
route, panel or console does what it should once something asks. So: the API
shapes are right as documented and as mocked, but a Portainer that answers
differently in some version-specific way would not have been caught here. The
console has never carried a keystroke to a real shell — the relay, the ticket
handoff and the terminal are each tested against fakes on both sides, which is
not the same as a pty. Nothing has run on a boat, on a Raspberry Pi, or over a
link bad enough to matter.

Treat the first run against a real instance as the beginning of testing, not the
end of it, and start with a Portainer whose containers you can afford to lose.

## License

MIT — see [LICENSE](LICENSE).
