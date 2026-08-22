# signalk-portainer

[![SignalK Plugin CI](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml)

A Signal K server plugin that manages [Portainer CE](https://www.portainer.io/)
over its HTTP API — containers, stacks, images, volumes and networks — and
publishes container health into the Signal K data model.

Portainer may run on the same machine as the Signal K server or on any other
reachable host, and several Portainer instances may be configured at once
(boat and shore, for example). Each is configured with its own scheme, host,
port, TLS settings, credentials and environment.

> **Status: M2a — container lifecycle (server side).** Read-only APIs, the
> admin-UI panel, and container start/stop/restart/kill/remove behind their
> guards. The UI buttons are M2b; delta publishing is M3.

## Documents

- [`docs/plan.md`](docs/plan.md) — architecture, configuration schema, Signal K
  integration, safety rails, milestones, and the settled design decisions.
- [`docs/portainer-api.md`](docs/portainer-api.md) — researched reference of the
  Portainer CE 2.x API surface the plugin uses.
- [`docs/signalk-webapp.md`](docs/signalk-webapp.md) — the Signal K embedded
  webapp contract: Module Federation, the fixed `./AppPanel` name, React
  singleton sharing, and why cookie auth makes the facade design correct.

## In one paragraph

The plugin talks to Portainer server-side (never from the browser: no CORS, no
token in the client, no self-signed-cert interstitial, no mixed content) and
exposes its own small REST facade under `/plugins/signalk-portainer/api/*`,
protected by Signal K's own authentication. On top of that facade sit an
embedded webapp for day-to-day container work. Planned for M2–M3: a delta
poller turning container state into Signal K paths under
`system.docker.<instance>.*`, watchdog notifications raising a Signal K alarm
when a container that should be running is not, and PUT handlers so any Signal
K client can start or stop a container.

## What works today (M2a)

- Configure one or more Portainer instances (protocol, host, port, base path,
  TLS, API token or username/password, environment).
- The plugin resolves each instance's Docker environment, probes Swarm support,
  and reports connected versions in its Signal K plugin status.
- An **embedded panel in the Signal K admin UI** with an instance selector and
  read-only tables for environments, containers, stacks, images, volumes and
  networks — plus services and nodes when the environment is a Swarm. It polls
  every 10s and surfaces facade errors with their hint rather than an empty
  table.
- **Container lifecycle** — start, stop, restart, kill and remove, each behind
  the guards below. Exposed by the API only for now; the panel's buttons are
  M2b.
- A REST facade under `/plugins/signalk-portainer/api/`, authenticated by
  Signal K. Every route takes `?instance=<name>`, defaulting to the first
  enabled instance:

  | Route | Returns |
  | --- | --- |
  | `GET /instances` | configured instances and which is default |
  | `GET /health` | reachability, version and capabilities per instance |
  | `GET /environments` | environments with health, and which is selected |
  | `GET /capabilities` | swarm support, swarm id, Docker and Portainer versions |
  | `GET /containers` | container list (`?all=true` to include stopped) |
  | `GET /containers/:id` | container inspect |
  | `GET /stacks` | stacks belonging to this environment |
  | `GET /stacks/:id/file` | the stack's compose file |
  | `GET /images` `/volumes` `/networks` `/df` | inventory and disk usage |
  | `GET /swarm/services` `/swarm/nodes` | 404 unless the daemon is a swarm |
  | `GET /control` | what the UI may offer, and whether self-protection is active |
  | `POST /containers/:id/:action` | `start` · `stop` · `restart` · `kill` |
  | `DELETE /containers/:id` | remove (`?force=` `?removeVolumes=`) |

### Guards on the mutating routes

Three independent checks, each enforced server-side regardless of what the UI
offers:

- **Control disabled** — every mutating route returns 403 unless
  `allowPutControl` is set.
- **Destructive disabled** — removal additionally requires `allowDestructive`.
  `removeVolumes` defaults to false, so a container's data is never destroyed
  by implication.
- **Self-protection** — the plugin identifies the container it runs in and
  refuses to start, stop, restart, kill or remove it. Stopping that container
  stops Signal K, the admin UI and the plugin issuing the request, leaving no
  way back except a shell on the host. Override with `allowSelfManagement`.

Identification reads `/proc/self/cgroup`, falls back to `/proc/self/mountinfo`
(cgroup v2 often hides the id), then to the hostname, which Docker defaults to
the short container id. If the plugin is containerised but cannot identify
itself — a custom `--hostname` under cgroup v2 with no bind mounts — it says so
in `GET /control` rather than implying a protection it cannot provide.

Requires Node.js 22 or newer — the versions CI actually verifies.

> Declaring Node 22 means Venus OS / Cerbo GX, which ships Node 20, is out of
> scope. The Signal K shared workflow reads `engines.node` and skips its
> ES2023 compatibility check once the declared major is 22 or above, so that
> compatibility is no longer checked either.

```bash
npm install        # install dependencies
npm run lint       # eslint
npm run format:check
npm test           # 188 unit tests, no network required, 80% coverage enforced
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

| | Decision |
| --- | --- |
| **Namespace** | `system.docker.<instance>.*`, prefix configurable, with Signal K metadata (units, display names) so dashboards render it properly. |
| **Multiple Portainers** | Configured as an array from v1 — adding a second instance is configuration, not a migration. |
| **Swarm** | Auto-detected from `docker/info`; swarm views appear only when the daemon is in a swarm. No toggle. |
| **Delta keys** | Compose service identity first (`project_service`), then stack, then container name, then short id — so `docker compose up` recreating a container does not move its paths. |

Rationale for each is in [`docs/plan.md` §10](docs/plan.md#10-decisions).

## License

MIT — see [LICENSE](LICENSE).
