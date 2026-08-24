# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Every write is no longer refused with **403 Refusing a request from another
  site** when Signal K is published through a reverse proxy. The check compared
  the browser's `Origin` against the address the request arrived on, which
  behind nginx is the internal `http://127.0.0.1:3000` rather than the
  `https://boat.example:4443` the operator used. It now takes the browser's own
  `Sec-Fetch-Site` verdict where one is offered — that survives any proxy — and
  falls back for older browsers to a comparison that counts the forwarded
  address as ours, reading `X-Forwarded-Proto`, `X-Forwarded-Host`,
  `X-Forwarded-Port` and `Forwarded`. A cross-site write is still refused, and a
  refusal now names both addresses in the plugin's log.

### Added

- A **Behind a reverse proxy** section in the README: what nginx, Caddy and
  Traefik have to forward for the same-site check, the console's WebSocket
  upgrade and the live log stream, with a worked nginx `location` block.

## [0.1.1] - 2026-08-23

The release that loads. 0.1.0 could not be started at all; everything below
exists because of that, plus what the review of the fix turned up.

### Fixed

- **The plugin loads.** 0.1.0 as published does not: it imports `express` at
  runtime while declaring it only under `devDependencies`, so a fresh install
  fails with `Cannot find module 'express'` and the plugin never starts. The
  JSON body parsing that needed it now uses `body-parser`, which is a real
  dependency. This is the whole reason for 0.1.1.
- One instance that fails validation no longer takes the working ones with it.
  The bad entry is dropped and named in the plugin status, and the Portainer
  that was answering perfectly well keeps its panel, its deltas and its
  watchdog.
- Log output from a container started with a TTY is no longer discarded when it
  is shorter than a frame header, and a UTF-8 character split across two
  network chunks no longer arrives as a replacement character.
- Two containers whose names normalise to the same Signal K key — `ais-logger`
  beside `ais_logger` — no longer publish onto one path, where the value
  flickered between them. The collision is broken by appending the short id.
- A slow browser reading a live log no longer makes the plugin buffer the
  container's output without limit.
- Cached reads and the panel's error banner no longer outlive what they
  describe: a failure that has passed clears, and a mutation is not answered
  from a cache filled before it.
- The panel's dialogs are usable from the keyboard: focus moves into a dialog
  when it opens, stays inside it while it is open, and returns to the control
  that opened it afterwards. The table tabs are marked up as tabs.
- A panel request whose deadline expires while the response body is arriving is
  reported as the timeout it is. The deadline used to be released as soon as the
  headers came back, so a server that answered and then stalled mid-body left
  the row's buttons disabled with no error and no way back.
- A **Containers a Signal K PUT may control** entry naming an instance that does
  not exist is named in the plugin status. Because the allowlist is consulted
  only while it has entries, a single typo silently refused every container; the
  entry is still kept — dropping the last bad one would empty the list, and an
  empty list allows everything — but the operator is now told why nothing
  matches.
- A button the plugin has gated looks gated again. Keeping it focusable for
  screen-reader users had dropped the dimming with the native `disabled`
  attribute, so an inert control was indistinguishable from a live one.
- Closing a half-filled new stack asks first when only its environment variables
  have been entered. The dirty check looked at the compose file and the git URL
  alone, and threw those rows away without a word.

### Changed

- A refused Portainer request now says what Portainer said. The message it sent
  is surfaced instead of being replaced by a generic one, so "environment 3 not
  found" reads as itself rather than as a bare 404.
- The GitHub Actions used by CI are pinned to commit SHAs, and Dependabot keeps
  them current alongside the npm dependencies.

### Added

- Two App Store screenshots in the package manifest, so the plugin's entry in
  the Signal K app store shows the panel and the configuration page rather than
  a name alone.
- CI packs the tarball, installs it on its own declared dependencies and starts
  the plugin from it. That is the check the missing `express` walked past: the
  test suite ran against a tree where every devDependency was present.

## [0.1.0] - 2026-08-23

The first published release. It is on npm and in the Signal K plugin registry,
and it **does not load**: see the `express` defect under 0.1.1. Install 0.1.1
instead.

**Not yet exercised against a real Portainer.** Start with an instance whose
containers you can afford to lose.

### Added

#### Portainer connection

- Any number of Portainer instances, each with its own address and credentials
  — so a boat and a shore server can be managed from one panel. The address is
  one field, written the way it is everywhere else: `https://boat.local:9443`,
  and a port only where it is not the scheme's own. The settings almost nobody
  changes — request timeout and the TLS options below — sit under **Advanced**,
  so what has to be filled in to connect is all that is asked for.
- Authentication by API access token (`ptr_…`) or by username and password,
  with the JWT refreshed as needed. Credentials stay server-side; the browser
  never sees one.
- TLS with a supplied CA certificate, an SNI servername override for
  connecting by IP, and verification disabled only as an explicit per-instance
  choice.
- The Docker environment is chosen by pressing its row on the panel's
  Environments tab, and the plugin writes that choice back into its own
  configuration — so the delta poller and the watchdog work against the same
  one, and it survives a restart. A Portainer with exactly one environment
  resolves it without being asked. A Swarm capability probe comes with it, so
  swarm views appear only where the daemon is in a swarm.
- Environment health taken from Portainer's own verdict: `Status` for direct
  environments and `Heartbeat` for edge ones, rather than a locally recomputed
  check-in window that would call a healthy async edge agent — or one behind a
  host whose clock disagrees with Portainer's — down.

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
- The panel opens on Environments: which Docker host it is working against is
  the first thing to establish, and on a Portainer with several it is the first
  thing that has to be answered. Pressing a row chooses it — the row already
  says what the environment is, where it lives and whether it is answering,
  which is what the choice actually turns on.
- Lifecycle buttons per container. Everything that interrupts something already
  running is behind a confirmation step that names the container and says what
  the action does to it; starting and resuming are not, since their worst case
  is that nothing happens.
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
- An app icon, so the plugin has a tile of its own in the webapp list and the
  App Store rather than the monogram the server falls back to. It is
  Portainer's crane-and-P mark drawn in Signal K's own two colours — the blue
  and yellow of the burgee — since the plugin is neither Portainer nor a plain
  Signal K plugin but the one working the other.

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

#### Documentation

- Screenshots of the panel, the configuration page and the published Signal K
  paths in the README, captured from the plugin running in a real Signal K
  admin UI against a fixture Portainer — including the first-run state where
  the environment has still to be chosen.
- `tools/screenshots/` — the fixture Portainer those captures run against, and
  the script that drives the admin UI and takes them, so an image can be
  retaken rather than edited when the panel changes.
- A Docker Compose example for running Portainer CE itself, with what each of
  its choices is for: the LTS tag, a data directory that does not move with the
  working directory, a restart policy that respects a container stopped on
  purpose, and a port published to the Signal K server rather than to the boat.

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

[Unreleased]: https://github.com/KEGustafsson/signalk-portainer/compare/0.1.1...HEAD
[0.1.1]: https://github.com/KEGustafsson/signalk-portainer/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/KEGustafsson/signalk-portainer/releases/tag/0.1.0
