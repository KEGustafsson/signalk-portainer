# signalk-portainer

[![SignalK Plugin CI](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-portainer/actions/workflows/signalk-ci.yml)

A Signal K server plugin that manages [Portainer CE](https://www.portainer.io/)
over its HTTP API — containers, stacks, images, volumes and networks — and
publishes container health into the Signal K data model.

Portainer may run on the same machine as the Signal K server or on any other
reachable host, and several Portainer instances may be configured at once
(boat and shore, for example). Each is configured with its own scheme, host,
port, TLS settings, credentials and environment.

> **Status: M0 — skeleton and client.** The Portainer client, instance
> registry, configuration validation and the `/instances` + `/health` facade
> routes are implemented and tested. The UI, delta publishing and container
> lifecycle actions land in M1–M3.

## Documents

- [`docs/plan.md`](docs/plan.md) — architecture, configuration schema, Signal K
  integration, safety rails, milestones, and the settled design decisions.
- [`docs/portainer-api.md`](docs/portainer-api.md) — researched reference of the
  Portainer CE 2.x API surface the plugin will use.

## In one paragraph

The plugin talks to Portainer server-side (never from the browser: no CORS, no
token in the client, no self-signed-cert interstitial, no mixed content) and
exposes its own small REST facade under `/plugins/signalk-portainer/api/*`,
protected by Signal K's own authentication. On top of that facade sit an
embedded webapp for day-to-day container work, a delta poller that turns
container state into Signal K paths under `system.docker.<instance>.*`,
watchdog notifications that raise a Signal K alarm when a container that should
be running is not, and PUT handlers so any Signal K client can start or stop a
container.

## What works today (M0)

- Configure one or more Portainer instances (protocol, host, port, base path,
  TLS, API token or username/password, environment).
- The plugin resolves each instance's Docker environment, probes Swarm support,
  and reports connected versions in its Signal K plugin status.
- Two facade routes, authenticated by Signal K:
  `GET /plugins/signalk-portainer/api/instances` and `.../api/health`.

Requires Node.js 20.18.1 or newer (the version `undici` needs).

```bash
npm install        # install dependencies
npm run lint       # eslint
npm run format:check
npm test           # 93 unit tests, no network required, 80% coverage enforced
npm run build      # emits dist/
```

These same commands run in CI via the Signal K project's shared
[`plugin-ci`](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml)
reusable workflow, on Node 22 and 24 across Linux x64, Linux arm64, macOS and
Windows. It additionally validates the plugin entry point and schema,
the start/stop/restart lifecycle, deprecated server API usage, npm pack
completeness and App Store compatibility — and reports armv7 (Cerbo GX / Venus
OS) results, which are advisory.

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
