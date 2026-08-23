import type { PluginConfig } from './config';
import { joinPath, matchesContainerIdentity } from './paths';
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

/**
 * A container that has gone between the guard and the call.
 *
 * A poll can land in the space between `refusalFor`'s lookup and `apply`'s, and
 * the two used to collapse into one "The plugin is not running" — a message
 * about the plugin, for a plugin that is running perfectly well, when the truth
 * is that the container is no longer there.
 */
class MissingContainerError extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = 'MissingContainerError';
  }
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

/** The one wording for a key that resolves to no container, used by both checks. */
function unknownContainer(instance: string, key: string): string {
  return `No container is currently known for ${key} on ${instance}`;
}

/**
 * May a Signal K PUT control this container?
 *
 * An empty allowlist means every container, which is what an operator who
 * never opened the setting gets. A non-empty one is exact: a reference that
 * matches nothing simply allows nothing, because failing open here would turn
 * a typo into the very exposure the setting exists to prevent.
 */
function putAllowed(
  allowed: readonly { instance: string; container: string }[],
  instance: string,
  key: string,
  container: { id: string; name?: string } | undefined,
): boolean {
  if (allowed.length === 0) return true;
  if (!container) return false;
  return allowed.some(
    (entry) =>
      entry.instance === instance && matchesContainerIdentity(container, key, entry.container),
  );
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

    const allowed = this.deps.config()?.control.putContainers ?? [];
    for (const key of keys) {
      // Not registered at all rather than registered and refused: an
      // unregistered path is not writable by anyone, so the allowlist holds
      // even if a later refusal check is missed.
      if (!putAllowed(allowed, instance, key, this.lookup(instance, key))) continue;
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
          // A container that has gone is the writer's 404, not a gateway
          // failure: nothing was ever sent to Docker.
          const statusCode = cause instanceof MissingContainerError ? cause.statusCode : 502;
          callback({ state: 'FAILED', statusCode, message });
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
      return { state: 'FAILED', statusCode: 404, message: unknownContainer(instance, key) };
    }

    // Re-checked rather than trusted from registration time: the allowlist can
    // change under a handler Signal K has already been given, and there is no
    // way to withdraw one.
    if (!putAllowed(control.putContainers, instance, key, container)) {
      return {
        state: 'FAILED',
        statusCode: 403,
        message: `${key} is not in the list of containers a Signal K PUT may control`,
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
    // Reserved for the one thing it actually describes: the plugin stopped
    // between the guard and the call, so there is nothing left to send with.
    if (!registry) throw new Error('The plugin is not running');

    const container = this.lookup(instance, key);
    // A poll refreshes the lookup table while a PUT is on its way here, so a
    // container removed a moment ago lands in this gap. It is the same absence
    // `refusalFor` reports, and it says so in the same words.
    if (!container) throw new MissingContainerError(unknownContainer(instance, key));

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
