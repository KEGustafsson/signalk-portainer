# signalk-portainer — design & implementation plan

A Signal K server plugin that manages Portainer CE over its HTTP API. Portainer
may live on the same machine as Signal K or on any other reachable host, and
more than one Portainer may be configured at once.

Researched API details live in [`portainer-api.md`](./portainer-api.md).
The four design questions this plan opened with are settled in [§10](#10-decisions).

---

## 1. Why an API client and not an embedded iframe

Wrapping the Portainer web UI in a reverse proxy gives you Portainer's UI and
nothing else. Speaking the API instead buys four things a proxy cannot:

- **Signal K deltas** — container health becomes boat data, visible in KIP,
  Freeboard, Grafana, logged by the standard history plugins.
- **PUT control** — any Signal K client can start/stop a container by writing to
  a path, so a dashboard button or an automation rule can do it.
- **Notifications** — a container that dies becomes a Signal K alarm like any
  other boat alarm, routed through the existing notification plumbing.
- **No proxy fragility** — no cookie-domain, CSP, base-path or WebSocket-upgrade
  rewriting to maintain.

The cost is that we implement the screens we want ourselves. That is acceptable:
onboard container management needs maybe 15% of Portainer's surface, and the
plugin's own UI can be laid out for a small chart-table screen.

## 2. Architecture

```
┌─────────────────────── Signal K server ────────────────────────┐
│                                                                │
│  Embedded webapp (React)                                       │
│        │  fetch /plugins/signalk-portainer/api/...             │
│        │  (Signal K session auth, admin-only)                  │
│        ▼                                                       │
│  Plugin HTTP facade  (registerWithRouter)                      │
│        │                                                       │
│        ├── InstanceRegistry ─────────────────────┐             │
│        │     one PortainerClient per instance    │             │
│        │     auth, TLS, retry, cache, redaction  │             │
│        │                                         │             │
│        ├── Poller ──► app.handleMessage(deltas)  │             │
│        └── PutHandlers ◄── app.registerPutHandler│             │
│                                                  │             │
└──────────────────────────────────────────────────┼─────────────┘
                                                   │ HTTPS + X-API-Key
                        ┌──────────────────────────┴──────────┐
                        ▼                                     ▼
              ┌──────────────────┐                  ┌──────────────────┐
              │ Portainer "local"│                  │ Portainer "shore"│
              │ same host        │                  │ anywhere         │
              └──────────────────┘                  └──────────────────┘
```

**The browser never talks to Portainer directly.** This is the load-bearing
decision. Four independent reasons:

1. The API token would have to be shipped to the browser to do so.
2. Portainer sends no CORS headers — a cross-origin `fetch` from the Signal K
   admin UI fails outright.
3. Portainer's default certificate on :9443 is self-signed. Node can be told to
   trust a pinned CA deliberately; a browser just shows an interstitial.
4. Signal K served over HTTPS + Portainer over HTTP on :9000 = blocked mixed
   content.

Server-side, all four disappear, and the facade gets Signal K's own
authentication for free.

## 3. Configuration

Plugin JSON schema, rendered by the Signal K admin UI. Secrets use
`"format": "password"` so the UI masks them; they are stored in
`~/.signalk/plugin-config-data/signalk-portainer.json` and never echoed back by
the facade (all responses run through a redactor).

Portainer targets are **an array from v1** (decision D2), so adding a second one
is configuration, never a migration.

```jsonc
{
  "instances": [
    {
      "name": "local",              // identity: also the Signal K path segment
      "enabled": true,
      "connection": {
        "protocol": "https",        // http | https
        "host": "localhost",        // same box, boat LAN, or ashore
        "port": 9443,
        "basePath": "",             // if Portainer sits behind a path prefix
        "timeoutMs": 10000
      },
      "tls": {
        "rejectUnauthorized": true, // secure by default
        "caCert": "",               // PEM for Portainer's self-signed cert
        "servername": ""            // SNI override when connecting by IP
      },
      "auth": {
        "mode": "apiKey",           // apiKey | userPass
        "apiKey": "",               // ptr_...  →  X-API-Key
        "username": "",
        "password": ""              // →  POST /api/auth, JWT cached ~8h
      },
      "environment": { "id": null, "name": "" }   // null = auto-select
    }
  ],
  "telemetry": {
    "level": "health",              // off | health | full — see §6.1
    "intervalSeconds": 30,
    "emitStats": false,             // one API call per container per tick
    "pathPrefix": "system.docker"
  },
  "control": {
    "allowPutControl": true,
    "allowDestructive": false,      // remove / prune / delete stack
    "allowSelfManagement": false,   // act on the container running Signal K
    "watchdog": []                  // [{instance, container}] that must run
  }
}
```

`name` is the instance's identity: it keys the facade, names the tab in the UI,
and forms the Signal K path segment. It must be unique, and renaming it moves
the data paths — so the schema description says exactly that.

**One environment per instance.** A single Portainer can front several Docker
environments; the config picks one per instance. Managing two environments from
the same Portainer means listing that Portainer twice under different names.
This keeps the instance the single unit of identity everywhere — config, facade,
UI tab, Signal K path.

Config is validated on `start()`; a bad target fails loudly through
`app.setPluginError()` rather than silently retrying forever. One unreachable
instance degrades to a warning and never blocks the others.

## 4. Client layer

### 4.1 `PortainerClient`

One class per instance, no external HTTP dependency — Node 18 `fetch` with an
`undici` `Agent` supplying the TLS options.

```ts
interface PortainerClientOptions {
  baseUrl: string;                 // https://host:9443
  auth: { apiKey: string } | { username: string; password: string };
  tls?: { ca?: string; rejectUnauthorized?: boolean; servername?: string };
  timeoutMs?: number;
}

class PortainerClient {
  // typed REST surface
  systemStatus(): Promise<PortainerStatus>;
  listEnvironments(opts?: { excludeSnapshots?: boolean }): Promise<Environment[]>;
  capabilities(): Promise<{ swarm: boolean; swarmId?: string; version: string }>;
  listStacks(): Promise<Stack[]>;
  stackFile(id: number): Promise<string>;
  startStack / stopStack / updateStack / redeployStackGit(...): Promise<void>;

  // docker proxy — thin, typed per resource
  docker: {
    listContainers(all?: boolean): Promise<DockerContainer[]>;
    inspectContainer(id: string): Promise<DockerContainerInspect>;
    start / stop / restart / kill / remove(...): Promise<void>;
    logs(id: string, o: LogOpts): Promise<string>;
    logStream(id: string, o: LogOpts): AsyncIterable<LogFrame>;
    statsOnce(id: string): Promise<DockerStats>;
    listImages / pullImage / listVolumes / listNetworks / info / df(...);
    listServices / listNodes(...);          // only when capabilities().swarm
  };

  // low-level escape hatch, used by everything above
  raw(method: string, path: string, init?: RawInit): Promise<Response>;
}
```

The resolved environment id is bound at construction, so no call site ever
passes one — the "never guess an environment id" rule is enforced by the type
signature rather than by discipline.

Behaviour baked into the client:

- **Auth header selection.** `apiKey` → `X-API-Key`. `userPass` → `POST /api/auth`,
  cache the JWT with its issue time, refresh proactively at 7h and reactively
  once on a `401`. The two never mix.
- **Environment resolution.** Lists once at construction, caches 60s, matches by
  configured id or name, falls back to the sole environment if there is exactly
  one, and errors clearly if there are several and none is configured.
- **Capability probing.** `GET /docker/info` once at startup (cached 5m) decides
  Swarm support (decision D3) and yields the `SwarmID` that swarm stack creation
  needs. No Swarm toggle in the config; nothing Swarm-shaped is offered when the
  daemon is not in a swarm.
- **Edge-aware health.** For `Type` 4/7 compute health from `LastCheckInDate`
  (`now - last <= 2×interval + 20s`), not `Status`.
- **Bounded reads.** `excludeSnapshots=true` on environment listings,
  `stats?stream=false` for polling, `tail=` always set on logs. Snapshot and
  `StackFileContent` fields are dropped before caching.
- **Stream demuxing.** Non-TTY log/attach streams carry 8-byte frame headers;
  the client parses them into `{stream: 'stdout'|'stderr', text}` frames so
  callers never see raw framing.
- **Cache + coalescing.** environments 60s, stacks 15s, containers 5s, `info` 5m.
  Identical in-flight requests share one promise.
- **Error mapping.** 400/401/403/404/409 → typed `PortainerError` with an
  actionable message ("token sent as Bearer instead of X-API-Key",
  "environment 3 not found — ids are creation-order, not names",
  "endpoint is Portainer EE only").
- **Redaction.** Tokens and passwords are never logged, never returned; `app.debug`
  output runs through a scrubber.

### 4.2 `InstanceRegistry`

Owns the `Map<name, PortainerClient>`, builds it from config on `start()`, tears
it down on `stop()`, and tracks per-instance health so one unreachable Portainer
never stalls the poller or the UI. Everything above the registry — facade,
poller, PUT handlers — addresses an instance by name and is agnostic to how many
exist.

## 5. HTTP facade

Mounted by `registerWithRouter(router)` at
`/plugins/signalk-portainer/api/*`. Signal K authenticates the request; the
facade additionally requires an admin-level principal for anything that mutates.

Every route below takes `?instance=<name>`, defaulting to the first enabled
instance so single-Portainer setups never mention it.

```
GET    /instances                               names, health, version, capabilities
GET    /health                                  plugin + all instances
GET    /environments                            id, name, type, health, counts
GET    /containers                              list (?all=true)
GET    /containers/:id                          inspect
POST   /containers/:id/:action                  start|stop|restart|kill
DELETE /containers/:id                          guarded by allowDestructive
GET    /containers/:id/logs?tail=&since=        one-shot
GET    /containers/:id/logs/stream              Server-Sent Events
GET    /containers/:id/stats                    one snapshot
GET    /stacks                                  list
GET    /stacks/:id/file                         compose yaml
POST   /stacks/:id/:action                      start|stop|redeploy
PUT    /stacks/:id                              update compose / env
GET    /images | /volumes | /networks | /df
POST   /images/pull                             {image, tag}
POST   /prune/:kind                             guarded by allowDestructive
GET    /swarm/services | /swarm/nodes           404 unless capabilities.swarm
```

**Streaming choice.** Logs, Docker events and live stats go to the browser as
**SSE**, not WebSocket. The plugin holds the follow stream to Portainer, demuxes
it, and re-emits `text/event-stream`. SSE inherits the Signal K session cookie
automatically, reconnects on its own, and needs no second auth path. The one
place SSE cannot work is the interactive console (bidirectional), which is why
exec is deliberately last (§8, M6).

## 6. Signal K integration — what makes this a Signal K plugin

### 6.1 Path scheme

```
<prefix>.<instance>.<kind>.<key>.<field>
```

with `prefix` configurable (default `system.docker`) and `instance` the
configured instance name. The instance segment is always present, even with one
instance, so adding a second Portainer never rewrites existing paths.

```
system.docker.local.status.reachable                    boolean
system.docker.local.status.version                      string
system.docker.local.status.containersRunning            number
system.docker.local.status.containersTotal              number
system.docker.local.containers.<key>.state              "running" | "exited" | ...
system.docker.local.containers.<key>.health             "healthy" | "unhealthy" | "starting"
system.docker.local.containers.<key>.image              string
system.docker.local.containers.<key>.restartCount       number
system.docker.local.containers.<key>.uptime             seconds
system.docker.local.containers.<key>.cpuPercent         ratio    (emitStats only)
system.docker.local.containers.<key>.memoryBytes        bytes    (emitStats only)
system.docker.local.stacks.<name>.status                "active" | "inactive"
```

**`<key>` prefers the compose service identity** (decision D4). Resolution order:

1. `com.docker.compose.project` + `com.docker.compose.service` labels →
   `<project>_<service>`
2. the Portainer stack name + service, when the container belongs to a stack
3. the container name
4. the short container id, if the name is somehow unusable

Compose identity is chosen first because it survives the thing that actually
breaks paths in practice: `docker compose up` recreating a container. The
container id changes every recreate and the container name can change with it;
the service identity does not. Names are normalised — lowercased, non-alphanumerics
to `_` — so paths stay valid.

Each container also publishes its short id — the 12 hex characters `docker ps`
shows — and its name as paths (`.id`, `.name`), so the readable key never costs
you the ability to identify the exact container.

> Implemented in M3a as paths rather than as `$source` metadata, as this section
> originally proposed. A `SourceRef` encoding the container id would change on
> every recreate — the very thing the key resolution above exists to avoid — and
> would break source-based filtering for anyone using it. They are published at
> the `full` level only; see the telemetry levels below.

When a container disappears, its paths are emitted once with `null` and then
dropped, so stale rows do not linger in dashboards forever. Stopping the plugin
clears them the same way.

**Publishing level** (`telemetry.level`) decides how much of this is published.
`off` polls nothing at all; `health` publishes the instance status paths plus
each container's `state` and `health`; `full` adds `image`, `name` and `id`.
`health` is the default — it is what a dashboard and the watchdog read, and the
identifying strings never change, so republishing them every poll costs
bandwidth and log volume for no new information. The level is not a security
boundary: everything remains available through the REST facade regardless.

### 6.2 Metadata

On first publication each numeric path gets a Signal K meta delta — `units`
(`s`, `ratio`, `bytes`), `displayName`, and `description` — so KIP and Freeboard
render "CPU 12%" instead of a bare number on an unlabelled path. This is cheap
and it is the difference between data that is technically present and data that
is usable in a dashboard.

### 6.3 Notifications

Watchdog entries (`{instance, container}`) that are not running raise:

```
notifications.system.docker.local.containers.<key>
  { state: "alarm", method: ["visual"], message: "Container ais_logger is exited" }
```

Cleared to `normal` when the container comes back. An unreachable instance
raises `notifications.system.docker.<instance>.status`. This is the feature that
justifies the whole plugin at 3am in an anchorage: the chartplotter beeps when
the AIS-logger container dies.

### 6.4 PUT control

```ts
app.registerPutHandler(
  'vessels.self',
  'system.docker.<instance>.containers.<key>.state',
  handler          // accepts "running" | "stopped" | "restart"
);
```

Returns `{ state: 'PENDING' }` immediately and completes asynchronously, since
a container stop can take the full 10s timeout. Registered only when
`control.allowPutControl` is set, and it respects Signal K's own PUT security so
a read-only client cannot stop containers.

## 7. Safety rails

These are not optional polish — a container manager that can stop its own host
process is a footgun.

- **Self-protection.** On start, detect the container Signal K itself runs in
  (`/proc/self/cgroup` / `/proc/self/mountinfo` container id, fallback:
  hostname == container id prefix). Refuse every stop/restart/remove targeting
  it unless `allowSelfManagement` is explicitly enabled, and surface it in the
  UI as a locked row rather than a failing button. The check matches on
  container id, so it holds across every instance that can see this host.
- **Destructive ops off by default.** remove container, remove volume, delete
  stack and any prune require `allowDestructive` **and** a typed confirmation in
  the UI.
- **Volume removal is never implicit.** `removeVolumes` defaults to false
  everywhere; deleting a stack's data has to be asked for twice.
- **Read-only mode.** `allowPutControl: false` + `allowDestructive: false`
  yields a pure monitoring plugin — a sensible default for a shared boat.
- **Timeouts everywhere.** No unbounded request; a wedged Portainer must not
  wedge the Signal K event loop.
- **Backpressure on streams.** One follow-stream per container per client,
  capped total; dropped when the SSE client disconnects.

## 8. Milestones

| # | Deliverable | Contents |
| --- | --- | --- |
| **M0** | Skeleton + client | Repo scaffold (TS, jest, eslint, webpack), `PortainerClient` with auth/TLS/env-resolution/capability probe, `InstanceRegistry`, `/instances` + `/health`, plugin status text. Unit tests against recorded fixtures. |
| **M1** | Read-only UI | Embedded webapp: instance selector, environments, containers, stacks, images/volumes/networks tables. Polling, no mutation. |
| **M2** | Container lifecycle | start/stop/restart/kill + self-protection + destructive guard. |
| **M3a** | Signal K deltas | Delta poller with the §6.1 key resolution, meta deltas, and the off/health/full publishing levels. |
| **M3b** | Signal K native | Watchdog notifications, PUT handlers, and container pause/unpause. |
| **M4** | Logs | SSE log streaming with frame demux, tail/since controls, download. |
| **M5** | Stacks write | compose editor, env vars, update/redeploy (incl. git redeploy), create from string/repository; swarm variants when `capabilities.swarm`. |
| **M6** | Console | WebSocket relay to `/api/websocket/exec` for an interactive shell. |

M0–M3 is the useful product; M4–M6 is the "actually replaces the Portainer UI
for daily use" tier. Swarm read views (`/swarm/services`, `/swarm/nodes`) ride
along in M1 behind the capability probe rather than forming a milestone of their
own.

## 9. Testing

- **Unit** — `PortainerClient` against recorded JSON fixtures via `nock`/msw:
  auth header selection, JWT refresh on 401, environment resolution ambiguity,
  capability probing with and without swarm, edge health computation, 8-byte
  frame demux, error mapping per status code.
- **Key resolution** — a dedicated table test for §6.1: compose labels present,
  stack-only, plain container, unusable name, and the rename/recreate case that
  must keep the same key.
- **Facade** — supertest against the express router with a stubbed registry,
  including `?instance=` routing, the auth guard and the destructive guard.
- **Integration (opt-in)** — a `docker-compose.test.yml` bringing up a real
  Portainer CE + a dummy container, run behind a tag so CI without Docker skips
  it. This is the only way to catch Portainer version skew.
- **UI** — testing-library on the panels, with the facade mocked.

## 10. Decisions

The four questions this plan opened with, now settled.

### D1 — Delta namespace: `system.docker.*`, configurable, with metadata

Signal K has no standard schema for container data, so this is a plugin-specific
namespace either way. `system.docker` is kept because it reads as what it is and
does not squat on a spec group whose meaning it would distort. `telemetry.pathPrefix`
stays configurable for anyone who wants it elsewhere, and §6.2 meta deltas make
the paths self-describing in dashboards. Treated as stable API from M3 onward.

### D2 — Multi-instance: array from v1

Upgraded from the original "v2, with a schema that grows into it". Making
`instances` an array on day one costs a `Map` and a `?instance=` query
parameter; deferring it costs a config migration and a path rewrite once
someone adds a shore Portainer. The UI ships one selector in M1 and is done.
Since the original requirement was that the target be adjustable, supporting
*several* adjustable targets is the honest reading of it.

### D3 — Swarm: auto-detected, never configured

`GET /docker/info` already reports whether the daemon is in a swarm, and its
`SwarmID` is required for swarm stack creation anyway. So the probe is free, and
the plugin adapts: swarm views and swarm stack variants appear when the daemon
is swarm-enabled and are absent otherwise. No toggle to get wrong, no dead UI on
a single-Pi boat — which is the overwhelmingly common case.

### D4 — Delta keys: compose service identity, container name as fallback

Upgraded from the original "container names with normalisation". Plain container
names break on the most ordinary operation there is — `docker compose up`
recreating a container — whereas the `com.docker.compose.project`/`service`
labels survive it. So the key resolves through compose identity first, stack
identity second, container name third, short id last, with the short id and the
name published as their own paths. Readable *and* stable, instead of choosing
one.
