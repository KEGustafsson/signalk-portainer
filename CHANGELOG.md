# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing has been published to npm yet, so everything below is the contents of
the first release rather than a change against one.

**Not yet exercised against a real Portainer.** See
[What has and has not been verified](README.md#what-has-and-has-not-been-verified)
before installing this anywhere you would mind losing a container.

### Added

#### Portainer connection

- Any number of Portainer instances, each with its own protocol, host, port,
  base path, request timeout, TLS settings and credentials — so a boat and a
  shore server can be managed from one panel.
- Authentication by API access token (`ptr_…`) or by username and password,
  with the JWT refreshed as needed. Credentials stay server-side; the browser
  never sees one.
- TLS with a supplied CA certificate, an SNI servername override for
  connecting by IP, and verification disabled only as an explicit per-instance
  choice.
- Environment resolution by id or by name, auto-selecting when Portainer has
  exactly one, plus a Swarm capability probe so swarm views appear only where
  the daemon is in a swarm.

#### REST facade

- A facade under `/plugins/signalk-portainer/api/`, authenticated by Signal K
  itself and taking `?instance=<name>` on every route.
- Reads: instances, health, environments, capabilities, containers, container
  inspect, stacks, stack compose files, images, volumes, networks, disk usage,
  and swarm services and nodes.
- Container lifecycle: start, stop, restart, kill, pause, unpause and remove.
- Stack writes: start, stop, git redeploy, compose and environment updates,
  creation from a compose string or a git repository, and deletion.
- Container logs, both as a one-shot read and as a live Server-Sent Events
  stream, with `tail`, `since` and `timestamps`.
- An authenticated container console: a WebSocket relay to Docker's exec
  socket, authorised by a single-use ticket rather than by the session cookie,
  since WebSocket upgrades are not subject to CORS.
- Secrets are redacted on the way out of every response.

#### Admin UI panel

- An embedded panel in the Signal K admin UI, with an instance selector and
  tables for environments, containers, stacks, images, volumes and networks —
  and services and nodes on a swarm. Polls every 10 seconds.
- Lifecycle buttons per container, each behind a confirmation step that names
  the container and says what the action does to it.
- A log viewer with follow, tail and since controls, an stderr filter, and a
  download.
- A stacks editor for the compose file and the stack's environment variables,
  with create, redeploy and delete.
- A terminal, opened from a container row: `/bin/sh`, `/bin/bash` or
  `/bin/ash`. xterm.js is fetched in its own chunk the first time a shell is
  opened, so a panel that never opens one never downloads it. `Ctrl+]` leaves
  the terminal for the Close button; Tab and Escape both remain available to
  the shell, so without it a shell reached by keyboard could not be left by
  one.

#### Signal K integration

- Container state published as deltas under `system.docker.<instance>.*`, with
  Signal K metadata so dashboards render labelled values.
- Three publishing levels — off, health, or full — rather than a single
  switch.
- Watchdog notifications raising a Signal K alarm when a container that should
  be running is not.
- PUT handlers, so any Signal K client can start or stop a container.
- Delta keys resolved by compose service identity first, then stack, then
  container name, then short id, so `docker compose up` recreating a container
  does not move its paths.

### Security

- **Self-protection.** The container running Signal K is identified from its
  cgroup and refused for every mutating operation — including by name, which
  Docker resolves to the same container, and including the stack that holds
  it. Overridable only by an explicit setting.
- **Three independent gates**, each enforced server-side however the UI
  behaves: `allowPutControl` for any mutation, `allowDestructive` for removals
  and deletions, `allowSelfManagement` for the Signal K container itself.
- **Console authorisation by ticket.** An admin-authenticated POST creates the
  exec instance and returns a single-use ticket, valid for 30 seconds and
  bound to that one shell. A socket arriving without one is closed knowing
  nothing else. Commands are argv, never a string to be split.
- **Same-origin only for anything that changes something.** A mutating route
  with no body is a CORS "simple request", so a page on another site could
  otherwise make the browser send one with the session cookie attached and
  simply not read the answer. Reads are unaffected, and a non-browser caller —
  already authenticated by Signal K — is left alone.
- **Bounded concurrency.** At most 8 log streams overall and 3 per container;
  at most 3 shells overall and 2 per container; at most 32 unredeemed console
  tickets. A shell left idle for 15 minutes is closed.

### Known limitations

- Portainer CE cannot remove a stack's volumes when the stack is deleted: its
  teardown runs `compose down` with no down-options, and there is no API
  parameter for it. The dialog says so rather than offering a checkbox that
  would report a removal that never happened.

- Requires a Signal K server new enough to let a plugin serve a WebSocket. On
  an older one the console is absent, and `GET /control` says why, rather than
  offering a button that cannot work.
- A stack deployed from a git repository is not updated by editing its compose
  file: Portainer's update handler detaches the stack from git. Change the file
  in the repository and redeploy instead.
- Updating a file-based stack drops any auto-update schedule Portainer had on
  it, which no field in the request can prevent. The answer says so.
