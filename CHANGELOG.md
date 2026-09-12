# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A robustness pass over every layer, from five reviews of the whole codebase, and
the Portainer and Docker calls the plugin was missing.

### Added

- **Container stats and processes.** `GET /containers/:id/stats` gives one
  reading of CPU, memory, network and block I/O, reduced the way `docker stats`
  reduces it — the page cache subtracted, the CPU share scaled by the number of
  CPUs — and `GET /containers/:id/top` lists what is running inside. Neither is
  polled: Docker samples twice a second apart to compute a CPU share.
- **Image pull.** `POST /images/pull` fetches an image or a newer version of
  one. Docker answers a pull as it starts and reports a failure inside the
  progress stream, so the stream is read to its end and a missing tag is an
  error rather than a success.
- **Container recreate.** `POST /containers/:id/recreate` moves a container
  started by hand onto a newer image, optionally pulling it first. Portainer's
  own operation, so the container's configuration, networks and volumes come
  across; needs Portainer 2.19 or newer, and is gated like any other removal.
- **Portainer update notice.** `GET /capabilities` reports whether Portainer
  has a newer release, when Portainer was able to check.

### Fixed

- **Self-protection no longer misidentifies a host as a container.** A Signal K
  installed on a Raspberry Pi beside Docker — the ordinary setup — has every
  running container's mounts in its own mount table, and the plugin read the
  first id it found there as its own: it then refused to stop that container,
  usually Portainer itself. The mount table is now read as a table, and only a
  mount whose destination is one of the three files Docker binds into a
  container counts. Podman is recognised too.
- **An allowlist can no longer empty itself.** A PUT-allowlist entry naming an
  instance that failed validation was dropped, and dropping the last entry
  opened every container to any readwrite client. Every entry is kept now,
  matching nothing until the name is corrected. A duplicate instance row no
  longer takes the working instance's watches and allowlist entries with it,
  and an instance named with different capitalisation matches.
- **A stack deploy waits for the deploy.** Portainer 2.42 answers an update or
  a redeploy immediately and deploys in the background (2.44 for a create), so
  "deployed" was reported while compose was still pulling and a failed deploy
  was never reported at all.
- **A git-backed stack redeploys with its own credentials.** The redeploy sent
  `RepositoryAuthentication: false`, so Portainer cloned anonymously and every
  private repository failed. The stored credentials are asked for by name now,
  and a redeploy can carry replacements in its body.
- **A saved environment that no longer exists is recoverable.** `GET
/environments` answered 404 — the one route that offers the list to choose
  from — and the panel then had no row to press and no field to clear.
- **Environments the plugin cannot manage are refused with a reason.**
  Kubernetes, Azure and an async Edge agent have no Docker API behind them;
  they were selectable, and then every read failed with a message about a
  tunnel or a manifest.
- **Stopping a container no longer times out while Docker is stopping it.**
  A stop with no explicit grace period ran under the 10s read budget while
  Docker held the request for the container's own grace period, so the operator
  got an error and a stopped container.
- **undici's own deadlines no longer end a quiet log stream or a long deploy.**
  Every client owns a dispatcher with both turned off, so the request's own
  budget is the only bound — and a dispatcher the host installed is honoured
  rather than bypassed.
- **A body that is not JSON is diagnosed.** A captive portal or a login page
  answering 200 with HTML was a bare `SyntaxError`; it now names the likely
  cause and quotes the start of what arrived.
- **The console relay holds a fast shell back.** Output was forwarded to the
  browser without reading what was queued for it, so `yes` on a LAN-speed
  Portainer relayed to a phone piled the difference into the heap. Both sockets
  are pinged, a peer that stops answering is dropped, and what the operator
  types before the shell exists is queued rather than lost.
- **A log line split across two reads is one line again.** TTY output arrives
  in network-sized chunks and Docker splits a message longer than 16 kB, so the
  viewer showed "…connection lo" and "st to 10.0.0.5" as two lines.
- **The demuxer asks Docker rather than guessing.** Docker 23 and newer say
  whether a log stream is multiplexed in the content type, so a TTY container
  that prints a short banner and goes quiet is no longer withheld.
- **The watchdog catches a container that is running but unhealthy**, gives a
  restarting or recreated container one poll to settle, and no longer sounds an
  alarm for a container an operator paused.
- **The panel recovers rather than dead-ends.** A hung backend is reported
  instead of "Loading…" forever, the poll backs off while reads fail and pauses
  while the tab is hidden, an action finishing after a tab switch no longer
  paints the wrong table, two actions in flight no longer re-enable each
  other's buttons, and what Portainer itself said about a failure is shown.
- **Warnings the server sends are shown**: an environment choice that could not
  be saved, and a stack update that took its auto-update settings with it.
- Smaller ones: a stack name is validated as the compose project name it
  becomes; environment variables are checked for the shapes Portainer would
  mangle; an image reference reaches Docker with its slashes intact; the
  per-container stream ceiling counts containers rather than spellings of an
  id; `?instance=` given twice is refused rather than falling back to the
  default; a JWT's own expiry is honoured; caches and timers use a monotonic
  clock; credentials in a URL are redacted; `start()` is idempotent.
- **An image reference can no longer climb out of the Docker proxy.** The
  slashes in `ghcr.io/owner/app` are kept as slashes so Docker reads the name
  whole, which made `..` among them a path segment the URL parser acted on:
  `DELETE /images/../../../stacks/3` resolved to `/api/stacks/3` and deleted a
  stack, past the ownership guard and the audit that route has. Empty, `.` and
  `..` segments are refused.
- **A console cannot be made to hold a message of any size.** The backlog
  kept for what is typed before the shell exists measured only what it was
  already holding, so the first message through — on a socket whose ticket had
  not been checked yet — was kept whatever its size.
- **Backpressure holds back whichever side is outrunning the other.** One
  drain timer belonged to the direction that congested first; the other could
  not pause its sender and ran to the hard limit, closing a console that flow
  control would have recovered.
- **A watchdog alarm that changes is published again.** Deduplicating on the
  alarm state alone held back everything that changes while an alarm stays an
  alarm — a container that went from exited to paused kept the sound it no
  longer wanted, and one that went from stopped to removed went on saying it
  was stopped.
- **A stack write and the deploy it waits for share one budget.** The settle
  poll started its deadline when the write was answered, so a single deploy
  could hold its caller for twice the configured write timeout.
- **A URL carrying a token rather than a user and password is redacted.** The
  forge form is `https://<token>@host`, with no colon for the pattern to find.
- **A value typed against a blank name is refused.** The row was dropped on its
  way to the request, so the stack deployed without a variable the operator had
  filled in and nothing said why.
- **A press of Select counts once.** The button sits inside a row that answers
  clicks of its own, and the press reached both — two switch requests for the
  same environment.
- **One polling timer, not several.** A tab becoming visible while a read was
  in flight left a second polling chain running, and the backoff counted for
  nothing.
- A pull's progress stream is read a line at a time rather than buffered
  whole, and a redeploy no longer sends a git credential id Portainer's
  redeploy route has never had a field for.

## [0.1.2] - 2026-08-24

The release that works behind a proxy and can free the disk. Every write was
refused with a 403 for anyone who publishes Signal K through nginx, Caddy or
Traefik. And the Images tab had no way to remove anything, though images are the
one inventory whose growth fills an SD card and takes Signal K down with it.

### Added

- A **Behind a reverse proxy** section in the README: what nginx, Caddy and
  Traefik have to forward for the same-site check, the console's WebSocket
  upgrade and the live log stream, with a worked nginx `location` block.
- **Images can be deleted and pruned from the panel.** The Images tab now
  carries a per-row Delete and a Reclaim space button, both behind **Allow
  destructive operations**. A prune removes untagged layers by default; a
  checkbox widens it to every image no container is using, which is the set
  that includes the previous tag of anything recently updated.
- The Images tab reports what the images cost and what a prune would free,
  using Docker's own `/system/df` arithmetic rather than a sum of the row
  sizes — two images built on one base share those layers, and adding both
  counts them twice. The read is made when the tab opens and after a prune,
  deliberately not on the ten-second poll.
- `DELETE /images/:reference` and `POST /images/prune` on the facade, both
  requiring control and destructive. Neither forces: Docker's refusal to
  remove an image a container references is what keeps the image Signal K runs
  from out of reach, and forcing would step over it.

Volumes and networks stay read-only. A deleted volume is the one loss nothing
in the panel can undo, and a detached network leaves a container reporting
`running` while being unreachable.

### Changed

- The ten type-aware lint rules that were staged at `warn` while the backlog
  they surfaced was worked off are errors like the rest of the set, so the next
  finding fails the run rather than joining a list. Clearing the backlog's one
  substantive finding moved the facade's async work into a wrapper: Express 4
  does nothing with a promise a route handler returns, and every route was an
  `async` function handed straight to it. Nothing had ever escaped that way —
  the handler already answered in every branch it could name — so this closes
  the gap rather than fixing a defect.

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

[Unreleased]: https://github.com/KEGustafsson/signalk-portainer/compare/0.1.2...HEAD
[0.1.2]: https://github.com/KEGustafsson/signalk-portainer/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/KEGustafsson/signalk-portainer/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/KEGustafsson/signalk-portainer/releases/tag/0.1.0
