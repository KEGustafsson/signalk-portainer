import type { Request, Response, Router } from 'express';
import { PortainerError } from './errors';
import { redactValue } from './redact';
import { InstanceRegistry, UnknownInstanceError } from './registry';

export interface FacadeDeps {
  registry: () => InstanceRegistry | undefined;
  log: (message: string) => void;
}

/**
 * The plugin's own REST surface. Signal K authenticates the request before it
 * reaches here; responses are redacted on the way out.
 */
export function registerRoutes(router: Router, deps: FacadeDeps): void {
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
      return {
        ok: instances.every((instance) => instance.reachable),
        instances,
      };
    }),
  );
}

type Handler = (req: Request, registry: InstanceRegistry) => Promise<Record<string, unknown>>;

function handle(deps: FacadeDeps, handler: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    const registry = deps.registry();
    if (!registry) {
      res.status(503).json({ error: 'Plugin is not started' });
      return;
    }
    try {
      const payload = await handler(req, registry);
      res.json(redactValue(payload));
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

/** Reads ?instance=<name>, defaulting to the first enabled instance. */
export function instanceParam(req: Request): string | undefined {
  const value = req.query.instance;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
