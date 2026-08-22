# signalk-portainer

[![SignalK Plugin CI](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml)

A Signal K server plugin that manages [Portainer CE](https://www.portainer.io/)
over its HTTP API — containers, stacks, images, volumes and networks — and
publishes container health into the Signal K data model.

Portainer may run on the same machine as the Signal K server or on any other
reachable host, and several Portainer instances may be configured at once
(boat and shore, for example). Each is configured with its own scheme, host,
port, TLS settings, credentials and environment.

> **Status: M1 complete — read-only APIs and UI.** The Portainer client,
> instance registry, configuration validation, the read-only facade and the
> embedded admin-UI panel are implemented and tested. Container lifecycle
> actions and delta publishing land in M2–M3.

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

## What works today (M1)

- Configure one or more Portainer instances (protocol, host, port, base path,
  TLS, API token or username/password, environment).
- The plugin resolves each instance's Docker environment, probes Swarm support,
  and reports connected versions in its Signal K plugin status.
- An **embedded panel in the Signal K admin UI** with an instance selector and
  read-only tables for environments, containers, stacks, images, volumes and
  networks — plus services and nodes when the environment is a Swarm. It polls
  every 10s and surfaces facade errors with their hint rather than an empty
  table.
- A read-only REST facade under `/plugins/signalk-portainer/api/`,
  authenticated by Signal K. Every route takes `?instance=<name>`, defaulting
  to the first enabled instance:

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

Requires Node.js 20.18.1 or newer (the version `undici` needs).

```bash
npm install        # install dependencies
npm run lint       # eslint
npm run format:check
npm test           # 152 unit tests, no network required, 80% coverage enforced
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
