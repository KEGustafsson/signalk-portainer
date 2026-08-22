# signalk-portainer

A Signal K server plugin that manages a [Portainer CE](https://www.portainer.io/)
instance over its HTTP API — containers, stacks, images, volumes and networks —
and publishes container health into the Signal K data model.

Portainer may run on the same machine as the Signal K server or on any other
reachable host; the target is fully configurable (scheme, host, port, TLS,
credentials, environment).

> **Status: design stage.** No implementation yet. The branch was reset to a
> clean slate and currently contains the research and the plan only.

## Documents

- [`docs/plan.md`](docs/plan.md) — architecture, configuration, Signal K
  integration, safety rails, milestones, open questions.
- [`docs/portainer-api.md`](docs/portainer-api.md) — researched reference of the
  Portainer CE 2.x API surface the plugin will use.

## In one paragraph

The plugin talks to Portainer server-side (never from the browser: no CORS, no
token in the client, no self-signed-cert interstitial, no mixed content) and
exposes its own small REST facade under `/plugins/signalk-portainer/api/*`,
protected by Signal K's own authentication. On top of that facade sit an
embedded webapp for day-to-day container work, a delta poller that turns
container state into Signal K paths under `system.docker.*`, watchdog
notifications that raise a Signal K alarm when a container that should be
running is not, and PUT handlers so any Signal K client can start or stop a
container.

## License

MIT — see [LICENSE](LICENSE).
