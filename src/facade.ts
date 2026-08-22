import type { Request, Response, Router } from 'express';
import type { PortainerClient } from './client';
import { environmentHealth } from './client';
import type { PluginConfig } from './config';
import { PolicyError, PortainerError } from './errors';
import { redactValue } from './redact';
import { InstanceRegistry, UnknownInstanceError } from './registry';
import { isSelfContainer, type SelfContainer } from './self';

export interface FacadeDeps {
  registry: () => InstanceRegistry | undefined;
  config: () => PluginConfig | undefined;
  /** Identity of the container this plugin runs in, for self-protection. */
  self: () => SelfContainer;
  log: (message: string) => void;
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
export function registerRoutes(router: Router, deps: FacadeDeps): void {
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
      const [environments, selected] = await Promise.all([
        client.listEnvironments({ excludeSnapshots: true }),
        client.environment(),
      ]);
      return {
        selected: selected.Id,
        environments: environments.map((environment) => ({
          id: environment.Id,
          name: environment.Name,
          type: environment.Type,
          url: environment.URL,
          health: environmentHealth(environment),
          isSelected: environment.Id === selected.Id,
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
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        throw new PortainerError({
          status: 400,
          method: 'GET',
          path: '/api/stacks/:id/file',
          message: `Stack id "${req.params.id}" is not a number`,
        });
      }
      return { id, content: await client.stackFile(id) };
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

      switch (action) {
        case 'start':
          await client.docker.startContainer(id);
          break;
        case 'stop':
          await client.docker.stopContainer(id);
          break;
        case 'restart':
          await client.docker.restartContainer(id);
          break;
        case 'kill':
          await client.docker.killContainer(id);
          break;
        case 'pause':
          await client.docker.pauseContainer(id);
          break;
        case 'unpause':
          await client.docker.unpauseContainer(id);
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

      await client.docker.removeContainer(id, { force, removeVolumes });
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
): void {
  const instance = instanceParam(req) ?? 'default instance';
  // The reference as asked for, plus what it resolved to when they differ —
  // a name in the request should still be traceable to a container id.
  const target =
    canonical && !canonical.startsWith(reference)
      ? `${reference} (${canonical.slice(0, 12)})`
      : reference;
  deps.log(`container ${action}: ${target} on ${instance}`);
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
async function resolveSelfReference(
  client: PortainerClient,
  reference: string,
): Promise<string | undefined> {
  const inspected = await client.docker.inspectContainer(reference);
  return typeof inspected.Id === 'string' && inspected.Id.length > 0 ? inspected.Id : undefined;
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
        res.status(404).json({ error: cause.message });
        return;
      }
      if (cause instanceof PolicyError) {
        // Refusals are logged as well as accepted mutations: an operator whose
        // button did nothing should find the reason in the same place.
        deps.log(`${req.method} ${req.path}: refused — ${cause.message}`);
        res.status(cause.status).json({ error: cause.message, hint: cause.hint });
        return;
      }
      if (cause instanceof PortainerError) {
        deps.log(`${req.method} ${req.path}: ${cause.message}`);
        res.status(cause.facadeStatus).json({
          error: cause.message,
          portainerStatus: cause.status,
          hint: cause.hint,
        });
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(`${req.method} ${req.path}: ${message}`);
      res.status(500).json({ error: message });
    }
  };
}
