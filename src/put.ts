import type { PluginConfig } from './config';
import { joinPath } from './paths';
import type { InstanceRegistry } from './registry';
import { isSelfContainer, type SelfContainer } from './self';

/**
 * Container control from any Signal K client: writing to a container's state
 * path starts, stops or restarts it, so a dashboard button or an automation
 * rule can do what the plugin's own panel does.
 *
 * The guards are the facade's guards, enforced again here rather than shared by
 * assumption — a PUT arrives through Signal K's own security, not through the
 * plugin's routes, so nothing the facade checks has been checked yet.
 */

export type PutState = 'running' | 'stopped' | 'restart';

const ACCEPTED: readonly PutState[] = ['running', 'stopped', 'restart'];

export interface ActionResult {
  state: 'COMPLETED' | 'PENDING' | 'FAILED';
  statusCode?: number;
  message?: string;
}

export type ActionHandler = (
  context: string,
  path: string,
  value: unknown,
  callback: (result: ActionResult) => void,
) => ActionResult;

export interface PutDeps {
  registry: () => InstanceRegistry | undefined;
  config: () => PluginConfig | undefined;
  self: () => SelfContainer;
  log: (message: string) => void;
  /** The server's registration function; kept injectable for the tests. */
  register: (context: string, path: string, handler: ActionHandler) => void;
}

/** Which container a key currently refers to, as of the last poll. */
export interface ContainerLookup {
  (instance: string, key: string): { id: string; name?: string } | undefined;
}

/** One container as a poll saw it, keyed by the path segment it publishes under. */
export interface KnownContainer {
  key: string;
  id: string;
  name?: string;
}

/**
 * The lookup table after a successful poll of one instance: this instance's
 * entries are replaced wholesale rather than merged.
 *
 * Merging would leave a removed container's key pointing at an id that no
 * longer exists, so a PUT to its path would be sent to Docker and come back as
 * a gateway error instead of the plain "no such container" the writer needs.
 * Other instances are untouched — this poll says nothing about them.
 */
export function replaceKnownContainers(
  known: ReadonlyMap<string, KnownContainer>,
  instance: string,
  containers: readonly KnownContainer[],
): Map<string, KnownContainer> {
  const next = new Map<string, KnownContainer>();
  const prefix = `${instance}/`;
  for (const [entry, container] of known) {
    if (!entry.startsWith(prefix)) next.set(entry, container);
  }
  for (const container of containers) next.set(`${prefix}${container.key}`, container);
  return next;
}

export class PutHandlers {
  /** Paths already registered, since keys are discovered poll by poll. */
  private readonly registered = new Set<string>();

  constructor(
    private readonly deps: PutDeps,
    private readonly lookup: ContainerLookup,
  ) {}

  /**
   * Registers a handler for each container discovered on this poll.
   *
   * Registration is deferred to discovery because the paths are not known until
   * the containers are: keys come from compose labels, not configuration.
   */
  register(instance: string, keys: Iterable<string>, prefix: string): void {
    if (!this.deps.config()?.control.allowPutControl) return;

    for (const key of keys) {
      const path = joinPath(prefix, instance, 'containers', key, 'state');
      if (this.registered.has(path)) continue;
      this.registered.add(path);
      this.deps.register('vessels.self', path, this.handlerFor(instance, key, path));
    }
  }

  private handlerFor(instance: string, key: string, path: string): ActionHandler {
    return (_context, _path, value, callback) => {
      const requested = String(value).toLowerCase() as PutState;
      if (!ACCEPTED.includes(requested)) {
        return {
          state: 'FAILED',
          statusCode: 400,
          message: `Unsupported value "${String(value)}" — expected one of: ${ACCEPTED.join(', ')}`,
        };
      }

      const refusal = this.refusalFor(instance, key, requested);
      if (refusal) return refusal;

      // PENDING now, the answer later: stopping a container can take the full
      // stop timeout, and Signal K should not be left holding the request.
      void this.apply(instance, key, requested)
        .then(() => {
          this.deps.log(`PUT ${path} = ${requested}: done`);
          callback({ state: 'COMPLETED', statusCode: 200 });
        })
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          this.deps.log(`PUT ${path} = ${requested}: ${message}`);
          callback({ state: 'FAILED', statusCode: 502, message });
        });

      return { state: 'PENDING' };
    };
  }

  /** The same three refusals the facade makes, checked before anything is sent. */
  private refusalFor(instance: string, key: string, requested: PutState): ActionResult | undefined {
    const control = this.deps.config()?.control;
    if (!control?.allowPutControl) {
      return {
        state: 'FAILED',
        statusCode: 403,
        message: 'Container control is disabled in the plugin configuration',
      };
    }

    const container = this.lookup(instance, key);
    if (!container) {
      return {
        state: 'FAILED',
        statusCode: 404,
        message: `No container is currently known for ${key} on ${instance}`,
      };
    }

    if (!control.allowSelfManagement && isSelfContainer(this.deps.self(), container.id)) {
      return {
        state: 'FAILED',
        statusCode: 403,
        message: `Refusing to ${requested === 'stopped' ? 'stop' : requested} the container running Signal K`,
      };
    }

    return undefined;
  }

  private async apply(instance: string, key: string, requested: PutState): Promise<void> {
    const registry = this.deps.registry();
    const container = this.lookup(instance, key);
    if (!registry || !container) throw new Error('The plugin is not running');

    const client = registry.get(instance);
    switch (requested) {
      case 'running':
        await client.docker.startContainer(container.id);
        return;
      case 'stopped':
        await client.docker.stopContainer(container.id);
        return;
      case 'restart':
        await client.docker.restartContainer(container.id);
        return;
    }
  }
}
