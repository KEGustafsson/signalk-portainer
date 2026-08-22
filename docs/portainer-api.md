# Portainer CE HTTP API — researched reference

Notes gathered for the `signalk-portainer` design. Everything below is Portainer
CE 2.x. Sources are listed at the bottom.

## 1. Base URL

```
https://<host>:9443/api/...    # default since 2.9 (self-signed cert out of the box)
http://<host>:9000/api/...     # legacy HTTP port, still common on LAN installs
```

The plugin must treat scheme, host and port as fully configurable — Portainer may
run on the same machine as Signal K, on another box on the boat LAN, or ashore.

## 2. Authentication — two mechanisms, do not mix them up

| Mechanism | Header | Lifetime | Use for |
| --- | --- | --- | --- |
| API access token | `X-API-Key: ptr_...` | long-lived, revocable in UI | automation (**preferred**) |
| JWT | `Authorization: Bearer <jwt>` | ~8 hours | when only user/password is known |

JWT is obtained with:

```http
POST /api/auth
Content-Type: application/json

{ "Username": "admin", "Password": "..." }
```

→ `{ "jwt": "eyJhbGciOi..." }`

The single most common failure is sending a `ptr_...` API token in a `Bearer`
header — Portainer answers `401` even though the credential is valid.

Token creation in the UI: **My account → Access tokens**. The token is shown once.

## 3. Three API surfaces

1. **Typed Portainer REST** — `/api/stacks`, `/api/endpoints`, `/api/registries`, …
   Documented in the bundled Swagger spec.
2. **Docker proxy** — `/api/endpoints/{id}/docker/<Docker Engine API path>`
   Forwards straight to the daemon. Request/response bodies are exactly the
   Docker Engine API. *Deliberately absent from the Swagger spec.*
3. **Kubernetes proxy** — `/api/endpoints/{id}/kubernetes/<k8s path>`
   Out of scope for a boat.

## 4. Environments ("endpoints")

```
GET    /api/endpoints?excludeSnapshots=true
GET    /api/endpoints/{id}
POST   /api/endpoints                       # multipart/form-data
PUT    /api/endpoints/{id}
DELETE /api/endpoints/{id}
POST   /api/endpoints/delete                # batch
       /api/endpoint_groups , /api/tags
```

**Never hardcode an environment ID.** IDs are assigned in creation order, not by
name — always resolve by listing first.

`Type` enum:

| Type | Meaning | Health signal |
| --- | --- | --- |
| 1 | Local Docker (socket) | `Status` |
| 2 | Agent on Docker | `Status` |
| 3 | Azure ACI | `Status` |
| 4 | Edge agent on Docker | check-in time |
| 5 | Local Kubernetes | `Status` |
| 6 | Agent on Kubernetes | `Status` |
| 7 | Edge agent on Kubernetes | check-in time |

`Status`: `1` = up, `2` = down. For Edge types (4, 7) `Status` is meaningless —
health is `now - LastCheckInDate <= 2 × interval + 20s`.

Snapshot fields (heavy — exclude unless needed): `ContainerCount`,
`RunningContainerCount`, `StoppedContainerCount`, `ImageCount`, `VolumeCount`,
plus full container/image lists.

Non-admin users see only the environments they are authorised for; an empty list
can mean "no permission", not "none exist".

## 5. Docker proxy paths (the workhorse)

Prefix every path with `/api/endpoints/{id}/docker`.

**Containers**

```
GET    /containers/json?all=true&filters={...}
GET    /containers/{id}/json
GET    /containers/{id}/top
GET    /containers/{id}/logs?stdout=true&stderr=true&tail=200&timestamps=true
GET    /containers/{id}/stats?stream=false
POST   /containers/create?name=<name>
POST   /containers/{id}/start
POST   /containers/{id}/stop?t=10
POST   /containers/{id}/restart?t=10
POST   /containers/{id}/kill
DELETE /containers/{id}?force=true&v=false
POST   /containers/{id}/exec
```

**Images / system / swarm**

```
POST   /images/create?fromImage=<image>&tag=<tag>   # pull; X-Registry-Auth for private
GET    /images/json
GET    /info                                        # includes Swarm cluster ID
GET    /events?since=&until=
GET    /services , GET /services/{id}/logs?stdout=true&tail=100
GET    /nodes
GET    /volumes , GET /networks , GET /system/df
```

Gotchas:

- The Docker API version prefix (`/v1.41/...`) is optional — omit it unless
  pinning behaviour.
- Logs and stats **must** be bounded. `stats?stream=false` gives one snapshot;
  `follow=true` on logs is a hijacked stream and must be demuxed, never used
  fire-and-forget from a script.
- When the container has no TTY, the log/attach stream is multiplexed with an
  **8-byte frame header** per chunk (`[stream_type, 0,0,0, size_be32]`).
- Private registry pulls need `X-Registry-Auth` with the encoded registry id.
- Containers created through the proxy show up in Portainer as **external** —
  anything compose-shaped should go through the Stacks API instead.

## 6. Stacks

**Create** (all variants need `?endpointId=N`):

```
POST /api/stacks/create/standalone/string       Name, StackFileContent, Env, Registries, Webhook
POST /api/stacks/create/standalone/file         Name, file (multipart), Env (JSON string)
POST /api/stacks/create/standalone/repository   Name, RepositoryURL, RepositoryReferenceName,
                                                ComposeFile, RepositoryAuthentication,
                                                AutoUpdate, TLSSkipVerify
POST /api/stacks/create/swarm/string            + SwarmID
POST /api/stacks/create/swarm/file              + SwarmID
POST /api/stacks/create/swarm/repository        + SwarmID
POST /api/stacks/create/kubernetes/{string|url|repository}
```

`SwarmID` comes from a proxy call to `GET /api/endpoints/{id}/docker/info`.

**Lifecycle**

```
GET    /api/stacks
GET    /api/stacks/{id}
GET    /api/stacks/{id}/file                    # the compose yaml
GET    /api/stacks/name/{name}
PUT    /api/stacks/{id}?endpointId=N            StackFileContent, Env, PullImage, Prune
PUT    /api/stacks/{id}/git?endpointId=N
PUT    /api/stacks/{id}/git/redeploy?endpointId=N   PullImage, Prune
POST   /api/stacks/{id}/start?endpointId=N
POST   /api/stacks/{id}/stop?endpointId=N
POST   /api/stacks/{id}/migrate?endpointId=N    EndpointID
POST   /api/stacks/webhooks/{webhookUUID}       # unauthenticated redeploy trigger
DELETE /api/stacks/{id}?endpointId=N&removeVolumes=true&external=true
```

Edge stacks: `/api/edge_stacks/create/{string|file|repository}` with `EdgeGroups`
and `DeploymentType` (0 = compose, 1 = kubernetes), plus GET/PUT/DELETE by id.

## 7. Other useful surfaces

```
GET  /api/status , /api/system/status      # version, instance id — good health probe
GET  /api/system/version                   # update availability
GET  /api/system/info , /api/system/nodes
POST /api/auth , POST /api/auth/logout
GET  /api/users/me                         # who am I / what role
GET  /api/users/admin/check                # is Portainer initialised at all
GET  /api/registries , POST /api/registries/ping
GET  /api/settings/public                  # unauthenticated — auth methods, features
GET  /api/motd
POST /api/backup , POST /api/restore
```

WebSocket (console):

```
wss://<host>/api/websocket/exec?endpointId=<n>&id=<execId>
wss://<host>/api/websocket/attach?endpointId=<n>&id=<containerId>
```

Recent Portainer versions dropped the `?token=` query parameter (it leaked JWTs
into logs and referers, GHSA-jvp4-q659-95mj). Authentication is now the
`Authorization` header for API clients, or the `portainer_api_key` HttpOnly
cookie for the browser. A server-side relay can set the header; a browser on a
different origin cannot.

## 8. Error semantics

| Code | Meaning |
| --- | --- |
| 400 | missing required query param or malformed body |
| 401 | wrong header type, or invalid/expired token |
| 403 | credential valid, RBAC role insufficient |
| 404 | wrong environment id, EE-only endpoint on CE, or version skew |
| 409 | conflict (e.g. stack name already exists) |

## Sources

- [Portainer docs — API access](https://docs.portainer.io/api/access)
- [Portainer docs — API usage examples](https://docs.portainer.io/api/examples)
- [portainer/portainer-skills — portainer-api SKILL.md](https://github.com/portainer/portainer-skills/blob/main/portainer-api/SKILL.md)
- [portainer/portainer-skills — references/stacks.md](https://github.com/portainer/portainer-skills/blob/main/portainer-api/references/stacks.md)
- [portainer/portainer-skills — references/docker-proxy.md](https://github.com/portainer/portainer-skills/blob/main/portainer-api/references/docker-proxy.md)
- [portainer/portainer-skills — references/environments.md](https://github.com/portainer/portainer-skills/blob/main/portainer-api/references/environments.md)
- [Advisory GHSA-jvp4-q659-95mj — JWT in URL query](https://github.com/portainer/portainer/security/advisories/GHSA-jvp4-q659-95mj)
- [Portainer HTTP API by example (deviantony gist)](https://gist.github.com/deviantony/77026d402366b4b43fa5918d41bc42f8)
