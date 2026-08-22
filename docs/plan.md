# signalk-portainer — design & implementation plan

A Signal K server plugin that manages a Portainer CE instance over its HTTP API.
The Portainer instance may live on the same machine as Signal K or on any other
reachable host, so the target is fully configurable.

Researched API details live in [`portainer-api.md`](./portainer-api.md).

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
│        ├── PortainerClient ──────────────────────┐             │
│        │     auth, TLS, retry, cache, redaction  │             │
│        │                                         │             │
│        ├── Poller ──► app.handleMessage(deltas)  │             │
│        └── PutHandlers ◄── app.registerPutHandler│             │
│                                                  │             │
└──────────────────────────────────────────────────┼─────────────┘
                                                   │ HTTPS + X-API-Key
                                                   ▼
                                         ┌──────────────────┐
                                         │  Portainer CE    │
                                         │  same host or    │
                                         │  anywhere on LAN │
                                         └──────────────────┘
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

```jsonc
{
  "connection": {
    "protocol": "https",          // http | https
    "host": "localhost",          // hostname or IP — same box or anywhere on the LAN
    "port": 9443,
    "basePath": "",               // if Portainer sits behind a path-prefixing proxy
    "timeoutMs": 10000
  },
  "tls": {
    "rejectUnauthorized": true,   // default secure
    "caCert": "",                 // PEM, for Portainer's self-signed cert
    "servername": ""              // SNI override when connecting by IP
  },
  "auth": {
    "mode": "apiKey",             // apiKey | userPass
    "apiKey": "",                 // ptr_...  → X-API-Key
    "username": "",
    "password": ""                // → POST /api/auth, JWT cached ~8h
  },
  "environment": {
    "id": null,                   // null = auto-select the only/first one
    "name": ""                    // optional: resolve by name instead of id
  },
  "telemetry": {
    "enabled": true,
    "intervalSeconds": 30,
    "emitStats": false,           // CPU/mem costs one API call per container
    "pathPrefix": "system.docker"
  },
  "control": {
    "allowPutControl": true,
    "allowDestructive": false,    // remove / prune / delete stack
    "allowSelfManagement": false, // act on the container running Signal K
    "watchdog": []                // containers that must stay running → alarms
  }
}
```

Config is validated on `start()`; a bad target fails loudly through
`app.setPluginError()` rather than silently retrying forever.

**Multi-instance** (boat Portainer + shore Portainer) is a real use case but a
v2 feature. The schema is shaped so `connection`/`auth`/`environment` can become
an array of named profiles without a breaking change — internally the client is
already instantiated per-profile from day one.

## 4. `PortainerClient`

One class, no external HTTP dependency — Node 18 `fetch` with an `undici`
`Agent` supplying the TLS options.

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
  listStacks(): Promise<Stack[]>;
  stackFile(id: number): Promise<string>;
  startStack(id: number, envId: number): Promise<void>;
  stopStack(id: number, envId: number): Promise<void>;
  redeployStackGit(id: number, envId: number, o: RedeployOpts): Promise<void>;
  updateStack(id: number, envId: number, o: UpdateStackOpts): Promise<void>;

  // docker proxy — thin, typed per resource
  docker: {
    listContainers(envId: number, all?: boolean): Promise<DockerContainer[]>;
    inspectContainer(envId: number, id: string): Promise<DockerContainerInspect>;
    start / stop / restart / kill / remove(...): Promise<void>;
    logs(envId: number, id: string, o: LogOpts): Promise<string>;
    logStream(envId: number, id: string, o: LogOpts): AsyncIterable<LogFrame>;
    statsOnce(envId: number, id: string): Promise<DockerStats>;
    listImages / pullImage / listVolumes / listNetworks / info / df(...);
  };

  // low-level escape hatch, used by everything above
  raw(method: string, path: string, init?: RawInit): Promise<Response>;
}
```

Behaviour baked into the client:

- **Auth header selection.** `apiKey` → `X-API-Key`. `userPass` → `POST /api/auth`,
  cache the JWT with its issue time, refresh proactively at 7h and reactively
  once on a `401`. The two never mix.
- **Never guess an environment id.** `resolveEnvironment()` lists once, caches
  60s, matches by configured id or name, falls back to the sole environment if
  there is exactly one, and errors clearly if there are several and none is
  configured.
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

## 5. HTTP facade

Mounted by `registerWithRouter(router)` at
`/plugins/signalk-portainer/api/*`. Signal K authenticates the request; the
facade additionally requires an admin-level principal for anything that mutates.

```
GET    /health                                  plugin + Portainer reachability, version
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
```

**Streaming choice.** Logs, Docker events and live stats go to the browser as
**SSE**, not WebSocket. The plugin holds the follow stream to Portainer, demuxes
it, and re-emits `text/event-stream`. SSE inherits the Signal K session cookie
automatically, reconnects on its own, and needs no second auth path. The one
place SSE cannot work is the interactive console (bidirectional), which is why
exec is deliberately last (§8, M6).

## 6. Signal K integration — what makes this a Signal K plugin

### 6.1 Deltas

Polled every `telemetry.intervalSeconds`, emitted with
`app.handleMessage(pluginId, delta)` under `telemetry.pathPrefix`
(default `system.docker`):

```
system.docker.environments.<envId>.reachable            boolean
system.docker.environments.<envId>.name                 string
system.docker.environments.<envId>.containersRunning    number
system.docker.environments.<envId>.containersTotal      number
system.docker.containers.<name>.state                   "running" | "exited" | ...
system.docker.containers.<name>.health                  "healthy" | "unhealthy" | "starting"
system.docker.containers.<name>.image                   string
system.docker.containers.<name>.restartCount            number
system.docker.containers.<name>.uptime                  seconds
system.docker.containers.<name>.cpuPercent              number   (emitStats only)
system.docker.containers.<name>.memoryBytes             number   (emitStats only)
system.docker.stacks.<name>.status                      "active" | "inactive"
```

Container names are normalised (lowercase, non-alphanumerics → `_`) so paths
stay valid. There is no standard Signal K schema for container data, so this
namespace is documented in the README as plugin-specific and kept stable.

`emitStats` is off by default: stats cost one API call per container per tick,
which is real load on a Pi.

### 6.2 Notifications

Containers listed in `control.watchdog` that are not running raise:

```
notifications.system.docker.containers.<name>
  { state: "alarm", method: ["visual"], message: "Container <name> is exited" }
```

Cleared to `normal` when the container comes back. Environment unreachable
raises `notifications.system.docker.environments.<id>`. This is the feature that
justifies the whole plugin at 3am in an anchorage: the chartplotter beeps when
the AIS-logger container dies.

### 6.3 PUT control

```ts
app.registerPutHandler(
  'vessels.self',
  'system.docker.containers.<name>.state',
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
  UI as a locked row rather than a failing button.
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
| **M0** | Skeleton + client | Repo scaffold (TS, jest, eslint, webpack), `PortainerClient` with auth/TLS/env-resolution, `/health`, plugin status text. Unit tests against recorded fixtures. |
| **M1** | Read-only UI | Embedded webapp: environments, containers, stacks, images/volumes/networks tables. Polling, no mutation. |
| **M2** | Container lifecycle | start/stop/restart/kill + self-protection + destructive guard. |
| **M3** | Signal K native | Delta poller, watchdog notifications, PUT handlers. |
| **M4** | Logs | SSE log streaming with frame demux, tail/since controls, download. |
| **M5** | Stacks write | compose editor, env vars, update/redeploy (incl. git redeploy), create from string/repository. |
| **M6** | Console | WebSocket relay to `/api/websocket/exec` for an interactive shell. |

M0–M3 is the useful product; M4–M6 is the "actually replaces the Portainer UI
for daily use" tier.

## 9. Testing

- **Unit** — `PortainerClient` against recorded JSON fixtures via `nock`/msw:
  auth header selection, JWT refresh on 401, environment resolution ambiguity,
  edge health computation, 8-byte frame demux, error mapping per status code.
- **Facade** — supertest against the express router with a stubbed client,
  including the auth and destructive guards.
- **Integration (opt-in)** — a `docker-compose.test.yml` bringing up a real
  Portainer CE + a dummy container, run behind a tag so CI without Docker skips
  it. This is the only way to catch Portainer version skew.
- **UI** — testing-library on the panels, with the facade mocked.

## 10. Open questions for review

1. **Delta namespace** — `system.docker.*` is proposed. If you prefer these
   under a vendor-ish prefix (e.g. `docker.*`) or under `electrical`/`network`,
   now is the time; it becomes stable API afterwards.
2. **Multi-instance in v1 or v2?** Plan assumes v2 with a v1 schema that grows
   into it without breaking. Say the word if boat+shore is needed immediately.
3. **Swarm support** — the API work is small (`SwarmID` from `docker/info`,
   `/services`, `/nodes`) but adds UI surface. Worth it, or standalone-only?
4. **Container names as delta paths** — stable and readable, but a renamed
   container orphans its path. The alternative is short container ids, which are
   stable but unreadable. Names proposed, with normalisation.
