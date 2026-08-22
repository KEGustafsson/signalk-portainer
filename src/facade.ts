import type { Request, Response, Router } from 'express';
import type { PortainerClient } from './client';
import { environmentHealth } from './client';
import { PortainerError } from './errors';
import { redactValue } from './redact';
import { InstanceRegistry, UnknownInstanceError } from './registry';

export interface FacadeDeps {
  registry: () => InstanceRegistry | undefined;
  log: (message: string) => void;
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
