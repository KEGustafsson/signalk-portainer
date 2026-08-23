import { randomBytes } from 'node:crypto';
import bodyParser from 'body-parser';
import type { NextFunction, Request, Response, Router } from 'express';
import type {
  PortainerClient,
  StackEnvVar,
  StackFromRepository,
  StackFromString,
  StackUpdate,
} from './client';
import { environmentHealth } from './client';
import type { PluginConfig } from './config';
import { PolicyError, PortainerError } from './errors';
import { redactValue } from './redact';
import { toLines } from './logframes';
import { InstanceRegistry, UnknownInstanceError } from './registry';
import { isSelfContainer, type SelfContainer } from './self';
import { stackHoldsSelf, stackOfContainer } from './stackguard';
import { StreamLimiter, StreamLimitError } from './streamlimit';
import type { ConsoleSessions } from './consolesessions';
import { ExecTicketError, type ExecTickets } from './exectickets';

/** What `registerRoutes` hands back, so the plugin can end what it started. */
export interface FacadeHandle {
  /** Ends every open log stream. Called when the plugin stops. */
  shutdown(): void;
}

export interface FacadeDeps {
  registry: () => InstanceRegistry | undefined;
  config: () => PluginConfig | undefined;
  /** Identity of the container this plugin runs in, for self-protection. */
  self: () => SelfContainer;
  log: (message: string) => void;
  /**
   * Persists the environment the panel picked, so the choice outlives the
   * process. Absent when the Signal K server offers no way to save plugin
   * options, and then a selection simply lasts until the plugin restarts.
   */
  saveEnvironment?: (instance: string, environmentId: number) => Promise<void>;
  /** Shared across requests so the ceiling is a ceiling; injectable for tests. */
  streams?: StreamLimiter;
  /** Keepalive period for open log streams; injectable for tests. */
  keepaliveMs?: number;
  /**
   * Where a console authorisation is recorded for the socket that follows.
   * Absent when the Signal K server cannot serve a WebSocket, and then the
   * console is not offered at all.
   */
  execTickets?: ExecTickets;
  /**
   * The consoles that are open, so a resize can find the shell it belongs to.
   * Absent alongside `execTickets`, for the same reason.
   */
  consoleSessions?: ConsoleSessions;
}

/**
 * How often an idle SSE stream sends a comment frame. Well inside the 60s that
 * proxies and NAT tables commonly use before reaping an idle connection.
 */
const KEEPALIVE_MS = 20_000;

/**
 * Refuses a state-changing request that came from another site.
 *
 * Signal K authenticates these routes with a session cookie, and a cookie is
 * attached by the browser however the request was started. `POST
 * /containers/mosquitto/kill` carries no body, which makes it a CORS "simple
 * request": no preflight, so the browser sends it and only hides the response.
 * The container is dead either way. Docker resolves names as well as ids —
 * which self-protection deliberately relies on — so an attacker needs no
 * container id, just a plausible name.
 *
 * `Origin` is set by the browser on exactly these requests and cannot be
 * forged by page script. A request without one is not from a browser form or
 * fetch — curl, a Signal K plugin, an automation — and those are already
 * authenticated by Signal K, so they are left alone rather than broken.
 */
export function sameOriginOnly(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (origin !== undefined && origin !== `${req.protocol}://${req.get('host')}`) {
    res.status(403).json({
      error: 'Refusing a request from another site',
      hint: 'this route changes something, so it is only accepted from the Signal K admin UI itself',
    });
    return;
  }

  // Browsers that send it say where the request came from even when Origin is
  // absent; anything else is left to the check above.
  const site = req.get('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({
      error: 'Refusing a request from another site',
      hint: 'this route changes something, so it is only accepted from the Signal K admin UI itself',
    });
    return;
  }

  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Reads ?tail= and ?since= into the client's log options. */
export function logOptions(req: Request): { tail?: number; since?: number; timestamps: boolean } {
  const tail = Number(req.query.tail);
  const since = Number(req.query.since);
  return {
    ...(Number.isFinite(tail) && tail > 0 ? { tail } : {}),
    ...(Number.isFinite(since) && since > 0 ? { since } : {}),
    timestamps: req.query.timestamps === 'true',
  };
}

const LIFECYCLE_ACTIONS = ['start', 'stop', 'restart', 'kill', 'pause', 'unpause'] as const;
type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

function isLifecycleAction(value: string): value is LifecycleAction {
  return (LIFECYCLE_ACTIONS as readonly string[]).includes(value);
}

/** Reads ?instance=<name>, defaulting to the first enabled instance. */
export function instanceParam(req: Request): string | undefined {
  const value = req.query.instance;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The plugin's own REST surface. Signal K authenticates the request before it
 * reaches here; responses are redacted on the way out.
 *
 * Every route accepts ?instance=<name>; omitting it selects the first enabled
 * instance, so single-Portainer setups never mention it.
 */
export function registerRoutes(router: Router, deps: FacadeDeps): FacadeHandle {
  const limiter = deps.streams ?? new StreamLimiter();
  const keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_MS;
  // Every log stream currently open. `stop()` has no other way to reach them:
  // the limiter and each request's AbortController live in this closure, and
  // the router is registered once and never revisited. Without this a stream
  // survives the plugin stopping — still relaying, still holding a permit
  // against a ceiling of 8 — until Signal K itself restarts.
  const openStreams = new Set<() => void>();

  router.use(sameOriginOnly);

  // ── instances and health ────────────────────────────────────────────────

  router.get(
    '/api/instances',
    handle(deps, async (_req, registry) => ({
      instances: registry.names.map((name) => ({
        name,
        isDefault: name === registry.defaultName,
        ...registry.get(name).describeSelf(),
      })),
    })),
  );

  router.get(
    '/api/health',
    handle(deps, async (_req, registry) => {
      const instances = await registry.health();
      return { ok: instances.every((instance) => instance.reachable), instances };
    }),
  );

  // ── environments ────────────────────────────────────────────────────────

  router.get(
    '/api/environments',
    withClient(deps, async (_req, client) => {
      // `environmentOrNone` rather than `environment`: this route is what the
      // picker reads, and refusing to list the choices because no choice has
      // been made yet would leave the operator no way to make one.
      const [environments, selected] = await Promise.all([
        client.listEnvironments({ excludeSnapshots: true }),
        client.environmentOrNone(),
      ]);
      return {
        selected: selected?.Id ?? null,
        environments: environments.map((environment) => ({
          id: environment.Id,
          name: environment.Name,
          type: environment.Type,
          url: environment.URL,
          health: environmentHealth(environment),
          isSelected: environment.Id === selected?.Id,
        })),
      };
    }),
  );

  router.get(
    '/api/capabilities',
    withClient(deps, async (_req, client) => ({
      capabilities: await client.capabilities(),
    })),
  );

  // ── containers ──────────────────────────────────────────────────────────

  router.get(
    '/api/containers',
    withClient(deps, async (req, client) => ({
      containers: await client.docker.listContainers(req.query.all === 'true'),
    })),
  );

  router.get(
    '/api/containers/:id',
    withClient(deps, async (req, client) => ({
      container: await client.docker.inspectContainer(req.params.id as string),
    })),
  );

  // ── stacks ──────────────────────────────────────────────────────────────

  router.get(
    '/api/stacks',
    withClient(deps, async (_req, client) => ({ stacks: await client.listStacks() })),
  );

  router.get(
    '/api/stacks/:id/file',
    withClient(deps, async (req, client) => {
      // The same check every other stack route makes. This route used to carry
      // its own copy, and the two had drifted: it accepted 0 and negative ids
      // that `stackId()` refuses.
      const id = stackId(req, 'GET', '/api/stacks/:id/file');
      return { id, content: await client.stackFile(id) };
    }),
  );

  // ── stack writes ────────────────────────────────────────────────────────

  /**
   * A compose file is text, and text arrives in a body. Bounded rather than
   * unlimited: this is a compose file, not an upload endpoint, and an
   * unbounded body is a way to make Signal K run out of memory.
   */
  const parseJson = bodyParser.json({ limit: '512kb' });
  const body = (req: Request, res: Response, next: (cause?: unknown) => void): void => {
    parseJson(req, res, (cause?: unknown) => {
      if (!cause) {
        next();
        return;
      }
      // Express would answer these itself, with an HTML page. Every other route
      // here answers { error, hint }, and a client that parses the answer
      // should not have to make an exception for two of them.
      const tooLarge = (cause as { type?: string }).type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge
          ? 'The request body is larger than 512kb'
          : 'The request body is not valid JSON',
        hint: tooLarge
          ? 'this route takes a compose file, not an upload'
          : 'send a JSON object with content-type: application/json',
      });
    });
  };

  /**
   * Chooses the environment this instance works against, from the panel.
   *
   * Persisted rather than held per browser: the delta poller and the watchdog
   * run server-side against the same client, so a choice only this tab knew
   * about would leave telemetry publishing nothing while the panel looked
   * fine. Saving it is also the point — it is what replaces editing the id
   * into the plugin configuration by hand.
   */
  router.put(
    '/api/environment',
    body,
    withClient(deps, async (req, client) => {
      const body = req.body as { id?: unknown } | undefined;
      const id = body?.id;
      // A number, not something `Number()` is willing to turn into one: that
      // coercion read `true` as environment 1 and `null` as environment 0, so
      // a picker sending the wrong shape selected a real Docker host instead
      // of being told what was wrong.
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        throw new PortainerError({
          status: 400,
          method: 'PUT',
          path: '/api/environment',
          message: `Environment id "${String(body?.id)}" is not a number`,
          hint: 'send { "id": <number> } from the environment picker',
        });
      }

      // Checked before it is stored, so a typo cannot persist a selection that
      // points at nothing and break the panel on the next restart.
      const environments = await client.listEnvironments({ excludeSnapshots: true });
      const match = environments.find((environment) => environment.Id === id);
      if (!match) {
        throw new PortainerError({
          status: 404,
          method: 'PUT',
          path: '/api/environment',
          message: `Portainer environment id ${id} not found`,
          hint: `available: ${environments.map((e) => `${e.Id}:${e.Name}`).join(', ')}`,
        });
      }

      client.selectEnvironment(id);

      const instance = instanceParam(req) ?? deps.registry()?.defaultName;
      let persisted = true;
      try {
        await deps.saveEnvironment?.(instance ?? '', id);
      } catch (cause) {
        // The selection is live either way; only its survival across a restart
        // is at stake, so this reports rather than fails the request.
        persisted = false;
        deps.log(
          `could not save the environment selection: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      return {
        selected: id,
        name: match.Name,
        persisted,
        ...(persisted
          ? {}
          : {
              warning: 'Selected for now, but it could not be saved and will not survive a restart',
            }),
      };
    }),
  );

  router.post(
    '/api/stacks',
    body,
    withClient(deps, async (req, client) => {
      requireControlEnabled(deps);
      const create = readStackCreate(req);
      // There is no stack id to guard yet, but the *name* is the guard: Docker
      // keys a compose project by name, so creating one that collides with the
      // project Signal K runs under can have Docker recreate that project from
      // a file which does not mention Signal K at all.
      await requireStackNameNotSelf(deps, client, create.name);
      const created =
        'content' in create
          ? await client.createStackFromString(create)
          : await client.createStackFromRepository(create);

      audit(deps, req, 'create', create.name, undefined, 'stack');
      return { ok: true, stack: created };
    }),
  );

  router.post(
    '/api/stacks/:id/:action',
    withClient(deps, async (req, client) => {
      const id = stackId(req, 'POST', '/api/stacks/:id/:action');
      const action = String(req.params.action);
      if (!isStackAction(action)) {
        throw new PortainerError({
          status: 400,
          method: 'POST',
          path: `/api/stacks/:id/${action}`,
          message: `Unknown stack action "${action}"`,
          hint: `supported actions: ${STACK_ACTIONS.join(', ')}`,
        });
      }

      requireControlEnabled(deps);
      // Starting a stack cannot take Signal K down with it; everything else can.
      if (action !== 'start') await requireStackNotSelf(deps, client, id, action);

      if (action === 'start') await client.startStack(id);
      else if (action === 'stop') await client.stopStack(id);
      else {
        const redeploy = readRedeploy(req);
        // Pruning removes the services the compose file no longer names, which
        // is destruction by another route: the containers go, and so does
        // anything they were the only thing keeping alive.
        if (redeploy.prune) requireDestructiveAllowed(deps);
        await client.redeployStack(id, redeploy);
      }

      audit(deps, req, action, String(id), undefined, 'stack');
      return { id, action, ok: true };
    }),
  );

  router.put(
    '/api/stacks/:id',
    body,
    withClient(deps, async (req, client) => {
      const id = stackId(req, 'PUT', '/api/stacks/:id');
      requireControlEnabled(deps);
      // An update restarts every container in the stack, Signal K included.
      await requireStackNotSelf(deps, client, id, 'update');

      const update = readStackUpdate(req);
      // Same reason as redeploy: a prune deletes whatever the new file dropped.
      if (update.prune) requireDestructiveAllowed(deps);
      const result = await client.updateStack(id, update);

      audit(deps, req, `update${update.prune ? ' --prune' : ''}`, String(id), undefined, 'stack');
      return {
        id,
        action: 'update',
        ok: true,
        // Said out loud rather than left to be discovered when the webhook
        // stops firing: Portainer drops auto-update on every stack update.
        ...(result.autoUpdateRemoved
          ? {
              warning:
                'Portainer removed this stack’s auto-update settings; its webhook URL no longer works and has to be recreated',
            }
          : {}),
      };
    }),
  );

  router.delete(
    '/api/stacks/:id',
    withClient(deps, async (req, client) => {
      const id = stackId(req, 'DELETE', '/api/stacks/:id');

      requireControlEnabled(deps);
      requireDestructiveAllowed(deps);
      await requireStackNotSelf(deps, client, id, 'delete');

      // No volume option: Portainer CE's stack delete takes no `removeVolumes`
      // parameter — its teardown runs `compose down` with no down-options — and
      // Go ignores an unknown query parameter, so sending one would succeed
      // while doing nothing. Reporting a volume removal that never happened is
      // worse than not offering it: an operator would recreate the stack later
      // and get the old database back believing it had been wiped.
      await client.deleteStack(id);

      audit(deps, req, 'delete', String(id), undefined, 'stack');
      return { id, action: 'delete', ok: true };
    }),
  );

  // ── inventory ───────────────────────────────────────────────────────────

  router.get(
    '/api/images',
    withClient(deps, async (_req, client) => ({ images: await client.docker.listImages() })),
  );

  router.get(
    '/api/volumes',
    withClient(deps, async (_req, client) => ({ volumes: await client.docker.listVolumes() })),
  );

  router.get(
    '/api/networks',
    withClient(deps, async (_req, client) => ({ networks: await client.docker.listNetworks() })),
  );

  router.get(
    '/api/df',
    withClient(deps, async (_req, client) => ({ df: await client.docker.diskUsage() })),
  );

  // ── logs ────────────────────────────────────────────────────────────────

  router.get(
    '/api/containers/:id/logs',
    withClient(deps, async (req, client) => {
      const id = String(req.params.id);
      const frames = await client.docker.logs(id, logOptions(req));
      return { id, lines: toLines(frames) };
    }),
  );

  /**
   * The log as it happens, as Server-Sent Events.
   *
   * SSE rather than a WebSocket because it inherits the Signal K session cookie,
   * reconnects on its own, and needs no second authentication path. Each line
   * is one event carrying `{ stream, text }`, so the browser can colour stderr
   * without parsing anything.
   */
  router.get('/api/containers/:id/logs/stream', (req: Request, res: Response) => {
    void streamLogs(deps, limiter, keepaliveMs, req, res, openStreams);
  });

  // ── control surface ─────────────────────────────────────────────────────

  /**
   * What the UI is permitted to offer. Sending this rather than letting the UI
   * guess keeps the buttons honest: a disabled action is disabled because the
   * server says so, and the same rules are enforced again below.
   */
  router.get(
    '/api/control',
    handle(deps, async () => {
      const control = deps.config()?.control;
      const self = deps.self();
      return {
        allowPutControl: control?.allowPutControl ?? false,
        allowDestructive: control?.allowDestructive ?? false,
        allowSelfManagement: control?.allowSelfManagement ?? false,
        console: {
          // The panel asks rather than assuming: an older Signal K server
          // cannot serve the WebSocket a console needs.
          available: deps.execTickets !== undefined,
          ...(deps.execTickets
            ? {}
            : {
                reason: control?.allowPutControl
                  ? 'this Signal K server cannot serve a plugin WebSocket'
                  : 'container control is disabled in the plugin configuration',
              }),
        },
        self: {
          inContainer: self.inContainer,
          identified: self.identified,
          shortId: self.shortId,
          source: self.source,
          // Says plainly when self-protection cannot work, instead of leaving
          // the operator to assume it does.
          protectionActive: self.identified && !(control?.allowSelfManagement ?? false),
          warning:
            self.inContainer && !self.identified
              ? 'Running in a container but unable to identify which one, so the Signal K container cannot be protected from being stopped'
              : undefined,
        },
      };
    }),
  );

  // ── console ─────────────────────────────────────────────────────────────

  /**
   * Asks for a shell, and gets back a ticket rather than a shell.
   *
   * This is where the console is authorised: Signal K requires an admin
   * session for this route, and the ticket carries that decision to the
   * WebSocket, which Signal K does not authenticate and CORS does not protect.
   * The exec instance is created here too, so a container that is gone or
   * stopped is a status the panel can show rather than a socket that opens and
   * closes for reasons nobody sees.
   */
  // Registered before /api/containers/:id/:action, which would otherwise match
  // "exec" as a lifecycle action and refuse it as an unknown one.
  router.post(
    '/api/containers/:id/exec',
    body,
    withClient(deps, async (req, client) => {
      // Before the tickets check, not after: tickets only exist while control
      // is enabled, so asking about them first blamed the Signal K server for
      // a switch in the plugin configuration — and contradicted /api/control,
      // which gets the same distinction right.
      requireControlEnabled(deps);
      const tickets = deps.execTickets;
      if (!tickets) {
        throw new PolicyError(
          'The console is not available on this Signal K server',
          'it needs a server new enough to let a plugin serve a WebSocket',
        );
      }

      const id = String(req.params.id);
      // A shell inside the Signal K container can stop Signal K as surely as
      // the stop button can, and with less to say about it afterwards.
      const canonical = await requireNotSelf(deps, client, id, 'open a shell in');

      const command = readExecCommand(req);
      // Reserved before the exec is created, not after: finding there is no
      // room for the ticket afterwards would leave an exec instance in Docker
      // that nothing can ever start, and a caller retrying accumulates them.
      const reservation = tickets.reserve();
      // A second handle, for resizing the terminal once it is open. Separate
      // from the ticket because the ticket is spent by the upgrade and travels
      // in a URL query; this one is only ever sent in a body.
      const session = randomBytes(16).toString('hex');
      let ticket: string;
      try {
        const execId = await client.createExec(id, command);
        ticket = reservation.commit({
          instance: instanceParam(req),
          execId,
          containerId: canonical ?? id,
          session,
        });
      } catch (cause) {
        reservation.release();
        throw cause;
      }

      audit(deps, req, `console ${command.join(' ')}`, id, canonical);
      return { id, ticket, session, command };
    }),
  );

  /**
   * Tells Docker how big the terminal is.
   *
   * Addressed by session rather than by container: two consoles may be open on
   * the same container, and only the socket knows which exec instance each one
   * became. The exec id itself never leaves the plugin.
   */
  router.post(
    '/api/console/resize',
    body,
    handle(deps, async (req, registry) => {
      requireControlEnabled(deps);
      const sessions = deps.consoleSessions;
      const payload = (req.body ?? {}) as Record<string, unknown>;
      const session = sessions?.get(
        typeof payload.session === 'string' ? payload.session : undefined,
      );
      if (!session) {
        // Also the answer for a console that has since ended, which is the
        // ordinary case: a dialog closing races its own last resize.
        throw new PortainerError({
          status: 404,
          method: 'POST',
          path: '/api/console/resize',
          message: 'That console is not open',
          hint: 'it may have ended already; close the terminal and open a new one',
        });
      }

      const size = readTerminalSize(payload);
      await registry.get(session.instance).resizeExec(session.execId, {
        rows: size.rows,
        columns: size.cols,
      });
      return { ...size };
    }),
  );

  // ── container lifecycle ─────────────────────────────────────────────────

  router.post(
    '/api/containers/:id/:action',
    withClient(deps, async (req, client) => {
      const action = String(req.params.action);
      const id = String(req.params.id);

      if (!isLifecycleAction(action)) {
        throw new PortainerError({
          status: 400,
          method: 'POST',
          path: `/api/containers/:id/${action}`,
          message: `Unknown container action "${action}"`,
          hint: `supported actions: ${LIFECYCLE_ACTIONS.join(', ')}`,
        });
      }

      requireControlEnabled(deps);
      const canonical = await requireNotSelf(deps, client, id, action);
      // The id the guard cleared, not the reference the caller sent. Docker
      // resolves a name at the moment it is used, so acting on the raw
      // reference is a second resolution — and a container recreated under the
      // same name in between would be a different container from the one
      // self-protection just inspected.
      const target = canonical ?? id;

      switch (action) {
        case 'start':
          await client.docker.startContainer(target);
          break;
        case 'stop':
          await client.docker.stopContainer(target);
          break;
        case 'restart':
          await client.docker.restartContainer(target);
          break;
        case 'kill':
          await client.docker.killContainer(target);
          break;
        case 'pause':
          await client.docker.pauseContainer(target);
          break;
        case 'unpause':
          await client.docker.unpauseContainer(target);
          break;
      }

      audit(deps, req, action, id, canonical);
      return { id, action, ok: true };
    }),
  );

  router.delete(
    '/api/containers/:id',
    withClient(deps, async (req, client) => {
      const id = String(req.params.id);
      const removeVolumes = req.query.removeVolumes === 'true';
      const force = req.query.force === 'true';

      requireControlEnabled(deps);
      requireDestructiveAllowed(deps);
      const canonical = await requireNotSelf(deps, client, id, 'remove');

      // The id the guard cleared, for the same reason the lifecycle routes use
      // it: the reference is resolved once, and acted on once.
      await client.docker.removeContainer(canonical ?? id, { force, removeVolumes });
      audit(
        deps,
        req,
        `remove${force ? ' --force' : ''}${removeVolumes ? ' --volumes' : ''}`,
        id,
        canonical,
      );
      return { id, action: 'remove', removeVolumes, ok: true };
    }),
  );

  // ── swarm (absent unless the daemon is a swarm member) ──────────────────

  router.get(
    '/api/swarm/services',
    withClient(deps, async (_req, client) => {
      await requireSwarm(client, '/api/swarm/services');
      return { services: await client.docker.listServices() };
    }),
  );

  router.get(
    '/api/swarm/nodes',
    withClient(deps, async (_req, client) => {
      await requireSwarm(client, '/api/swarm/nodes');
      return { nodes: await client.docker.listNodes() };
    }),
  );

  return {
    shutdown(): void {
      for (const end of [...openStreams]) end();
      openStreams.clear();
    },
  };
}

/**
 * Holds a follow stream open, relaying each line to the browser as an SSE event.
 *
 * Written against the raw response rather than through handle(): the reply is
 * an open stream, not a JSON body, and every error it can hit has to be
 * reported differently depending on whether anything has been sent yet.
 */
async function streamLogs(
  deps: FacadeDeps,
  limiter: StreamLimiter,
  keepaliveMs: number,
  req: Request,
  res: Response,
  openStreams: Set<() => void>,
): Promise<void> {
  const registry = deps.registry();
  if (!registry) {
    res.status(503).json({ error: 'Plugin is not started' });
    return;
  }

  const id = String(req.params.id);
  const instance = instanceParam(req) ?? registry.defaultName;
  let release: (() => void) | undefined;
  let keepalive: NodeJS.Timeout | undefined;

  try {
    const client = registry.get(instanceParam(req));
    release = limiter.acquire(`${instance}/${id}`);

    // The upstream stream is ended by this signal and nothing else, so the
    // browser navigating away has to reach it.
    const controller = new AbortController();

    // Registered before the await, not after. A browser that disconnects while
    // Portainer is still answering has already had its close event emitted by
    // the time the await resolves, and a listener added then never runs: the
    // follow stream would never be aborted, the loop below would write forever
    // into a dead socket, and the permit would be held until Signal K
    // restarted. Eight of those and every log stream is refused.
    const end = (): void => {
      controller.abort();
      release?.();
      openStreams.delete(end);
    };
    req.on('close', end);
    openStreams.add(end);

    // Awaited before any header is written, so a container that does not exist
    // is a 404 rather than a 200 stream carrying one error event — which an
    // EventSource would answer by reconnecting into a loop.
    const frames = await client.docker.logStream(id, controller.signal, logOptions(req));
    // The browser may have left while Portainer was answering. `destroyed` is
    // the flag that says so: `writableEnded` only becomes true once this
    // function itself has called end(), so it was never true here.
    if (req.destroyed || res.destroyed) return;

    // Headers first: an SSE client waits for them before it considers itself
    // connected, and until they are sent an error can still become a status.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would hold every line until the stream ended,
      // which for a follow stream is never.
      'x-accel-buffering': 'no',
    });
    res.write(`event: open\ndata: ${JSON.stringify({ id, instance })}\n\n`);

    // A quiet container sends nothing for hours, and an idle connection is
    // what proxies and NAT tables reap first. This comment frame costs two
    // bytes and keeps the connection observably alive; EventSource ignores it.
    keepalive = setInterval(() => {
      // A departed client shows up as a destroyed socket, not as an ended
      // writable: without this the keepalive kept firing into a dead socket
      // for up to a full interval after the tab closed.
      if (!res.destroyed) res.write(':\n\n');
    }, keepaliveMs);
    keepalive.unref?.();

    for await (const frame of frames) {
      if (res.destroyed) break;
      for (const line of toLines([frame])) {
        // Redacted like every other response body. The one-shot read goes
        // through `handle()`, which does this; the stream bypasses it, and a
        // container printing a token would otherwise have it masked on one
        // route and passed through verbatim on the other.
        const written = res.write(`data: ${JSON.stringify(redactValue(line))}\n\n`);
        // `write` returning false means the socket cannot take any more: a
        // chatty container over a slow link. Ignoring it — which is what
        // discarding this value did — accumulates the whole difference in the
        // Node heap, unbounded, because the stream ceiling limits how many
        // streams are open and not how many bytes each one holds. On a
        // Raspberry Pi that is what OOM-kills Signal K.
        if (!written) await drained(res, controller.signal);
        if (res.destroyed) break;
      }
    }
    // Docker ended it: a container that stopped, or a non-follow log that ran
    // out. Say so rather than letting the browser reconnect into a loop.
    if (!res.destroyed) {
      res.write('event: end\ndata: {}\n\n');
      res.end();
    }
  } catch (cause) {
    const failure = describeStreamFailure(cause);
    deps.log(`log stream ${instance}/${id}: ${failure.error}`);
    // Nothing to tell a socket that has gone, and writing to it throws.
    if (res.destroyed) return;
    if (res.headersSent) {
      // Mid-stream: the status is long gone, so the failure travels as an
      // event the browser can show beside the lines it already has. Redacted
      // like the data lines above: these messages interpolate what Portainer
      // and the guards said, and one route masking a token while the other
      // does not is the same leak.
      res.write(`event: error\ndata: ${JSON.stringify(redactValue(failure))}\n\n`);
      res.end();
    } else {
      res.status(failure.status).json(redactValue({ error: failure.error, hint: failure.hint }));
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
    release?.();
  }
}

/**
 * Waits until the response socket can take more, or until there is nobody left
 * to write to.
 *
 * The abort signal and the socket's own close are raced against 'drain' on
 * purpose: 'drain' never arrives on a socket whose reader has gone, so waiting
 * on it alone would leave this await — and the upstream log stream behind it —
 * pending for the life of the process.
 */
function drained(res: Response, signal: AbortSignal): Promise<void> {
  if (res.destroyed || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

function describeStreamFailure(cause: unknown): {
  status: number;
  error: string;
  hint?: string;
} {
  if (cause instanceof UnknownInstanceError) return { status: 404, error: cause.message };
  // No policy guard refuses a log stream today, but this route's own 403 would
  // otherwise fall through to the 500 below the moment one is added.
  if (cause instanceof PolicyError) {
    return { status: cause.status, error: cause.message, hint: cause.hint };
  }
  if (cause instanceof StreamLimitError) {
    return { status: cause.status, error: cause.message, hint: cause.hint };
  }
  if (cause instanceof PortainerError) {
    return { status: cause.facadeStatus, error: cause.message, hint: cause.hint };
  }
  // An abort is how this stream is supposed to end, not a failure to report.
  if (cause instanceof Error && cause.name === 'AbortError') {
    return { status: 200, error: 'stream closed' };
  }
  return { status: 500, error: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * One line per state change the guards let through, so the plugin's log answers
 * "what stopped that container" instead of only recording what it refused.
 *
 * It goes to `app.debug`, which is what the plugin API offers below `error`;
 * turn the plugin's switch on in the server's Log page to keep the trail.
 */
function audit(
  deps: FacadeDeps,
  req: Request,
  action: string,
  reference: string,
  canonical?: string,
  kind = 'container',
): void {
  const instance = instanceParam(req) ?? 'default instance';
  // The reference as asked for, plus what it resolved to when they differ —
  // a name in the request should still be traceable to a container id.
  const target =
    canonical && !canonical.startsWith(reference)
      ? `${reference} (${canonical.slice(0, 12)})`
      : reference;
  deps.log(`${kind} ${action}: ${target} on ${instance}`);
}

const STACK_ACTIONS = ['start', 'stop', 'redeploy'] as const;
type StackAction = (typeof STACK_ACTIONS)[number];

function isStackAction(value: string): value is StackAction {
  return (STACK_ACTIONS as readonly string[]).includes(value);
}

/** The stack id in the path, or a 400 that says what was wrong with it. */
function stackId(req: Request, method: string, path: string): number {
  const raw = String(req.params.id);
  // Digits, matched as text, before `Number()` sees it. `Number()` reads other
  // notations as numbers too: "0x3" becomes 3 and "1e1" becomes 10, so a
  // request naming one stack would stop a different one.
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) return id;
  }
  throw new PortainerError({
    status: 400,
    method,
    path,
    message: `Stack id "${raw}" is not a number`,
  });
}

/** A 400 about the request body, phrased for whoever sent it. */
function badRequest(method: string, path: string, message: string, hint?: string): PortainerError {
  return new PortainerError({ status: 400, method, path, message, ...(hint ? { hint } : {}) });
}

/**
 * Environment variables out of an untrusted body.
 *
 * Absent and empty are different answers: absent means "leave the stack's
 * environment alone", so undefined is passed through rather than flattened to
 * an empty list that would unset every variable the stack runs with.
 */
function readEnv(value: unknown, method: string, path: string): StackEnvVar[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw badRequest(method, path, 'env must be a list of { name, value }');
  }
  return value.map((entry) => {
    const pair = entry as { name?: unknown; value?: unknown };
    if (typeof pair?.name !== 'string' || pair.name.length === 0) {
      throw badRequest(method, path, 'every environment variable needs a name');
    }
    return { name: pair.name, value: typeof pair.value === 'string' ? pair.value : '' };
  });
}

/** The compose file and environment for an update. */
function readStackUpdate(req: Request): StackUpdate {
  const path = '/api/stacks/:id';
  const payload = (req.body ?? {}) as {
    content?: unknown;
    env?: unknown;
    prune?: unknown;
    pullImage?: unknown;
  };
  if (typeof payload.content !== 'string' || payload.content.trim().length === 0) {
    throw badRequest(
      'PUT',
      path,
      'content is required and must be the compose file as text',
      'send { content, env?, prune?, pullImage? }',
    );
  }
  const env = readEnv(payload.env, 'PUT', path);
  return {
    content: payload.content,
    ...(env ? { env } : {}),
    prune: payload.prune === true,
    pullImage: payload.pullImage === true,
  };
}

/** Redeploy options come from the query, since the route takes no body. */
function readRedeploy(req: Request): { prune: boolean; pullImage: boolean } {
  return { prune: req.query.prune === 'true', pullImage: req.query.pullImage === 'true' };
}

/**
 * A create, from either a compose file or a repository.
 *
 * Which one it is comes from what the body carries; asking for both is a
 * mistake rather than a preference, so it is refused instead of picking one.
 */
function readStackCreate(req: Request): StackFromString | StackFromRepository {
  const path = '/api/stacks';
  const payload = (req.body ?? {}) as {
    name?: unknown;
    content?: unknown;
    repositoryUrl?: unknown;
    reference?: unknown;
    composeFile?: unknown;
    env?: unknown;
    username?: unknown;
    password?: unknown;
  };

  if (typeof payload.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(payload.name)) {
    throw badRequest(
      'POST',
      path,
      'name is required, and may contain only letters, digits, dot, dash and underscore',
      'Docker uses the stack name as a resource-name prefix, so it has the same rules',
    );
  }

  const hasContent = typeof payload.content === 'string' && payload.content.trim().length > 0;
  const hasRepository =
    typeof payload.repositoryUrl === 'string' && payload.repositoryUrl.trim().length > 0;
  if (hasContent === hasRepository) {
    throw badRequest(
      'POST',
      path,
      'a stack comes from either a compose file or a repository',
      hasContent ? 'send content or repositoryUrl, not both' : 'send content or repositoryUrl',
    );
  }

  const env = readEnv(payload.env, 'POST', path);
  // Either half is enough to mean "this repository needs credentials": a token
  // in the password field with no username is how several git hosts are
  // reached, and requiring both would silently clone anonymously instead.
  const username = typeof payload.username === 'string' ? payload.username : '';
  const password = typeof payload.password === 'string' ? payload.password : '';
  const authentication = username || password ? { username, password } : undefined;

  if (hasContent) {
    return { name: payload.name, content: payload.content as string, ...(env ? { env } : {}) };
  }
  return {
    name: payload.name,
    repositoryUrl: payload.repositoryUrl as string,
    ...(typeof payload.reference === 'string' ? { reference: payload.reference } : {}),
    ...(typeof payload.composeFile === 'string' ? { composeFile: payload.composeFile } : {}),
    ...(env ? { env } : {}),
    ...(authentication ? { authentication } : {}),
  };
}

/**
 * The shell to run, from the request.
 *
 * A list of arguments, never a string to be split: a command assembled from
 * text and handed to a shell is how a request becomes an injection. Docker
 * takes argv directly, so there is no shell in between unless the operator
 * asked for one by name.
 */
function readExecCommand(req: Request): string[] {
  const path = '/api/containers/:id/exec';
  const asked = (req.body ?? {}) as { command?: unknown };
  if (asked.command === undefined) return [...DEFAULT_EXEC_COMMAND];
  if (
    !Array.isArray(asked.command) ||
    asked.command.length === 0 ||
    !asked.command.every((part) => typeof part === 'string' && part.length > 0)
  ) {
    throw badRequest(
      'POST',
      path,
      'command must be a non-empty list of strings',
      'send { "command": ["/bin/sh"] }, or leave it out for the default',
    );
  }
  if (asked.command.length > MAX_EXEC_ARGS) {
    throw badRequest('POST', path, `a command may have at most ${MAX_EXEC_ARGS} arguments`);
  }
  return asked.command as string[];
}

/** Present in every image worth opening a shell in; bash is not. */
const DEFAULT_EXEC_COMMAND = ['/bin/sh'] as const;
const MAX_EXEC_ARGS = 32;

/**
 * Bounds on a terminal size, wide enough for any real window.
 *
 * Docker takes these as the dimensions of a pty, and a browser reporting
 * nonsense — zero rows while the dialog is still laying out, or a number with
 * six digits — should be refused here rather than passed on.
 */
const MAX_TERMINAL = { cols: 1000, rows: 500 };

/** The terminal dimensions out of an untrusted body. */
function readTerminalSize(payload: Record<string, unknown>): { cols: number; rows: number } {
  const path = '/api/console/resize';
  const read = (name: 'cols' | 'rows'): number => {
    const value = payload[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw badRequest('POST', path, `${name} must be a whole number of at least 1`);
    }
    if (value > MAX_TERMINAL[name]) {
      throw badRequest('POST', path, `${name} may be at most ${MAX_TERMINAL[name]}`);
    }
    return value;
  };
  return { cols: read('cols'), rows: read('rows') };
}

/**
 * The stack version of the footgun guard.
 *
 * Container self-protection catches "stop this container"; this catches "stop
 * the stack that contains it", which is the same outcome reached by naming
 * something else. The stack's containers are read including stopped ones: a
 * Signal K that is currently down is still what the operator would lose.
 */
/**
 * Refuses a new stack whose name is the compose project Signal K runs under.
 *
 * The id-based guard cannot help here: the stack does not exist yet. What
 * exists is the name, and that is what Docker resolves.
 */
async function requireStackNameNotSelf(
  deps: FacadeDeps,
  client: PortainerClient,
  name: string,
): Promise<void> {
  const self = deps.self();
  if (deps.config()?.control.allowSelfManagement) return;
  if (!self.identified) return;

  const containers = await client.docker.listContainers(true);
  const mine = containers.find((container) => isSelfContainer(self, container.Id));
  const owner = mine ? stackOfContainer(mine) : undefined;
  if (!owner) return;
  if (owner.trim().toLowerCase() !== name.trim().toLowerCase()) return;

  throw new PolicyError(
    `Refusing to create a stack named ${name}, which is the compose project the container running Signal K belongs to`,
    'deploying it would let Docker recreate that project without Signal K in it; enable "Allow managing the Signal K container itself" if you really mean to',
  );
}

async function requireStackNotSelf(
  deps: FacadeDeps,
  client: PortainerClient,
  id: number,
  action: string,
): Promise<void> {
  const self = deps.self();
  if (deps.config()?.control.allowSelfManagement) return;
  if (!self.identified) return;

  const stacks = await client.listStacks();
  const stack = stacks.find((candidate) => candidate.Id === id);
  // An unknown id is the client's 404 to give, not a reason to refuse here.
  if (!stack) return;

  const containers = await client.docker.listContainers(true);
  if (stackHoldsSelf(stack.Name, self.id ?? self.shortId, containers)) {
    throw new PolicyError(
      `Refusing to ${action} stack ${stack.Name}, which contains the container running Signal K`,
      'this would stop the plugin issuing the request; enable "Allow managing the Signal K container itself" if you really mean to',
    );
  }
}

/** Every mutating route is off entirely when control is disabled. */
function requireControlEnabled(deps: FacadeDeps): void {
  if (deps.config()?.control.allowPutControl) return;
  throw new PolicyError(
    'Container control is disabled',
    'enable "Allow Signal K PUT control" in the plugin configuration',
  );
}

/** Removal destroys state, so it needs its own opt-in beyond control. */
function requireDestructiveAllowed(deps: FacadeDeps): void {
  if (deps.config()?.control.allowDestructive) return;
  throw new PolicyError(
    'Destructive operations are disabled',
    'enable "Allow destructive operations" in the plugin configuration',
  );
}

/**
 * The footgun this plugin exists to avoid: stopping the container that runs
 * Signal K takes the plugin, the admin UI and the operator's way back with it.
 *
 * Returns the canonical container id when it had to be resolved, so the audit
 * line names the container Docker actually acted on rather than the alias the
 * request used.
 */
async function requireNotSelf(
  deps: FacadeDeps,
  client: PortainerClient,
  reference: string,
  action: string,
): Promise<string | undefined> {
  const self = deps.self();
  if (deps.config()?.control.allowSelfManagement) return undefined;
  if (!self.identified) return undefined;

  if (isSelfContainer(self, reference)) throw selfRefusal(action);

  // The reference was not our id — but Docker resolves names too, so
  // "signalk-server" reaches exactly the container the id check just cleared.
  // Only Docker can say which container a name means, so ask it.
  const canonical = await resolveSelfReference(client, reference);
  if (canonical && isSelfContainer(self, canonical)) throw selfRefusal(action);
  return canonical;
}

/**
 * The canonical id behind a container reference, whether it was a name, a short
 * id or a full one.
 *
 * A failure here is not swallowed: if we cannot tell what a reference points
 * at, we cannot tell that it is not the Signal K container, and guessing is the
 * one outcome this guard exists to prevent. A missing container fails the
 * inspect with the same 404 the mutation itself would have returned.
 */
async function resolveSelfReference(client: PortainerClient, reference: string): Promise<string> {
  const inspected = await client.docker.inspectContainer(reference);
  if (typeof inspected.Id === 'string' && inspected.Id.length > 0) return inspected.Id;
  // A successful inspect with no Id in it is not "this is some other
  // container" — it is not knowing, and this guard exists precisely to refuse
  // when it cannot tell. A proxy or an agent answering `200 {}` would
  // otherwise open self-protection entirely.
  throw new PolicyError(
    `Refusing to act on ${reference}: Docker did not say which container that is`,
    'the inspect answered without an Id, so the plugin cannot tell it apart from the container running Signal K',
  );
}

function selfRefusal(action: string): PolicyError {
  return new PolicyError(
    `Refusing to ${action} the container running Signal K`,
    'this would stop the plugin issuing the request; enable "Allow managing the Signal K container itself" if you really mean to',
  );
}

/**
 * Swarm routes 404 rather than surfacing Docker's own error, so the UI can
 * treat "not a swarm" as a normal absence instead of a failure.
 */
async function requireSwarm(client: PortainerClient, path: string): Promise<void> {
  const capabilities = await client.capabilities();
  if (capabilities.swarm) return;
  throw new PortainerError({
    status: 404,
    method: 'GET',
    path,
    message: 'This environment is not a Swarm',
    hint: 'the Docker daemon is not an active swarm member, so there are no services or nodes',
  });
}

/**
 * The failure without the hint already folded into it.
 *
 * PortainerError puts the hint in `message` so one log line carries both, and
 * this response sends `hint` as its own field — so an untrimmed message made
 * every error the panel shows say the same thing twice.
 */
function withoutHint(cause: PortainerError): string {
  const suffix = cause.hint ? ` — ${cause.hint}` : '';
  return suffix && cause.message.endsWith(suffix)
    ? cause.message.slice(0, -suffix.length)
    : cause.message;
}

type RegistryHandler = (
  req: Request,
  registry: InstanceRegistry,
) => Promise<Record<string, unknown>>;
type ClientHandler = (req: Request, client: PortainerClient) => Promise<Record<string, unknown>>;

/** Resolves ?instance= to a client, then runs the handler. */
function withClient(deps: FacadeDeps, handler: ClientHandler) {
  return handle(deps, async (req, registry) => {
    const client = registry.get(instanceParam(req));
    const payload = await handler(req, client);
    return { instance: instanceParam(req) ?? registry.defaultName, ...payload };
  });
}

function handle(deps: FacadeDeps, handler: RegistryHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    const registry = deps.registry();
    if (!registry) {
      res.status(503).json({ error: 'Plugin is not started' });
      return;
    }
    try {
      res.json(redactValue(await handler(req, registry)));
    } catch (cause) {
      if (cause instanceof UnknownInstanceError) {
        res.status(404).json(redactValue({ error: cause.message }));
        return;
      }
      if (cause instanceof PolicyError || cause instanceof ExecTicketError) {
        // Refusals are logged as well as accepted mutations: an operator whose
        // button did nothing should find the reason in the same place.
        deps.log(`${req.method} ${req.path}: refused — ${cause.message}`);
        // Redacted like every other branch: these messages interpolate
        // upstream data — a stack name, a container reference — and a refusal
        // was the one answer that reached the browser unmasked.
        res.status(cause.status).json(redactValue({ error: cause.message, hint: cause.hint }));
        return;
      }
      if (cause instanceof PortainerError) {
        // Portainer's own words about the failure go in the log line too: they
        // are the difference between "failed with 400" and knowing which field
        // it objected to.
        deps.log(
          `${req.method} ${req.path}: ${cause.message}${cause.body ? ` — ${cause.body}` : ''}`,
        );
        res.status(cause.facadeStatus).json(
          redactValue({
            error: withoutHint(cause),
            portainerStatus: cause.status,
            hint: cause.hint,
            // What Portainer said, already redacted and capped at 500 chars by
            // PortainerError. Without it the panel can only ever show this
            // plugin's paraphrase of a failure Portainer explained.
            ...(cause.body ? { detail: cause.body } : {}),
          }),
        );
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(`${req.method} ${req.path}: ${message}`);
      res.status(500).json(redactValue({ error: message }));
    }
  };
}
