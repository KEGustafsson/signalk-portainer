import type { TelemetryLevel } from './config';
import { DeltaBuilder, type InstanceSnapshot, type MetaValue, type PathValue } from './deltas';
import { PortainerError } from './errors';
import { assignKeys } from './paths';
import type { InstanceRegistry } from './registry';
import type { DockerContainer } from './types';
import type { Notification, Watchdog } from './watchdog';

/**
 * The loop that turns Portainer into boat data.
 *
 * It owns no HTTP and no formatting: the registry fetches, DeltaBuilder decides
 * what to say, and this decides when — and makes sure a slow or broken instance
 * cannot stall the others or pile polls on top of each other.
 */

export interface PollerDeps {
  registry: () => InstanceRegistry | undefined;
  /** Publishes one delta's worth of values and meta. */
  publish: (values: PathValue[], meta: MetaValue[]) => void;
  log: (message: string) => void;
  intervalMs: number;
  pathPrefix: string;
  /** How much to publish. 'off' is handled by not constructing a poller. */
  level: Exclude<TelemetryLevel, 'off'>;
  /** Raises and clears container alarms; absent when nothing is watched. */
  watchdog?: Watchdog;
  publishNotifications?: (notifications: Notification[]) => void;
  /**
   * Told which container keys exist after each poll, so PUT handlers can be
   * registered for paths that only become known when a container appears.
   */
  onKeys?: (instance: string, keys: string[], containers: KeyedContainer[]) => void;
  /**
   * Reachability, every poll. The plugin status is otherwise a snapshot of
   * start(): a Portainer that comes up a minute later reads as down forever,
   * and one that dies at 02:00 still reads as connected at 03:00.
   */
  onHealth?: (instances: InstanceHealth[]) => void;
}

/** One container as the poller saw it, paired with the key it publishes under. */
/** What one instance looked like on the last poll. */
export interface InstanceHealth {
  name: string;
  reachable: boolean;
  error?: string;
}

export interface KeyedContainer {
  key: string;
  id: string;
  name?: string;
}

export class DeltaPoller {
  private timer: NodeJS.Timeout | undefined;
  private readonly builders = new Map<string, DeltaBuilder>();
  /** True while a poll is in flight, so a slow poll never overlaps itself. */
  private polling = false;
  private stopped = false;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.intervalMs);
    // A poll timer must never be the reason a Signal K server refuses to exit.
    this.timer.unref?.();
  }

  /**
   * Stops polling and clears what was published: a dashboard should not keep
   * showing a container as running after the plugin stopped watching it.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const values: PathValue[] = [];
    for (const builder of this.builders.values()) values.push(...builder.clear());
    this.builders.clear();
    if (values.length > 0) this.deps.publish(values, []);

    // An alarm nobody is maintaining is worse than no alarm: it reads as a
    // live problem while the thing that would clear it is no longer running.
    const cleared = this.deps.watchdog?.clear() ?? [];
    if (cleared.length > 0) this.deps.publishNotifications?.(cleared);
  }

  /** Exposed for tests, which drive the loop rather than waiting on a timer. */
  async poll(): Promise<void> {
    if (this.polling) return;
    const registry = this.deps.registry();
    if (!registry) return;

    this.polling = true;
    try {
      // Each instance is published the moment its own snapshot settles, not
      // when the slowest one does. Waiting for them all meant a shore
      // Portainer at the 120s timeout ceiling held the boat's own containers
      // for two minutes on a 30s interval — and the watchdog alarm that
      // follows them with it, which is exactly what the watchdog exists to
      // prevent.
      const health = await Promise.all(
        registry.names.map(async (name) => {
          const snapshot = await this.snapshot(registry, name);
          if (!this.stopped) this.publishInstance(name, snapshot);
          return {
            name,
            reachable: snapshot.reachable,
            ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
          };
        }),
      );
      if (this.stopped) return;

      // Reported once the whole poll has settled, because it is a statement
      // about the instances together: "1/2 reachable" cannot be assembled from
      // one instance at a time. Its own try, so a listener that throws cannot
      // stop the next poll either.
      try {
        this.deps.onHealth?.(health);
      } catch (cause) {
        this.deps.log(
          `reporting health failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    } catch (cause) {
      // A poll must never be worse than a poll that reports "unreachable".
      // `snapshot()` already contains network failures and `publishInstance`
      // its own; this is the backstop for everything else, because an
      // unhandled rejection here ends the whole Signal K process rather than
      // the poll.
      this.deps.log(`poll failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * One instance's snapshot, turned into deltas, alarms and PUT paths.
   *
   * Contained in its own try: a container list one instance answered with
   * something unexpected must not stop the instance beside it from publishing,
   * and must not stop the health report at the end of the poll either.
   */
  private publishInstance(name: string, snapshot: InstanceSnapshot): void {
    try {
      const built = this.builderFor(name).build(snapshot);
      if (built.values.length > 0 || built.meta.length > 0) {
        this.deps.publish(built.values, built.meta);
      }

      if (this.deps.watchdog) {
        const notifications = this.deps.watchdog.evaluate(name, snapshot);
        if (notifications.length > 0) this.deps.publishNotifications?.(notifications);
      }
      if (this.deps.onKeys && snapshot.reachable) {
        this.deps.onKeys(name, ...describeKeys(snapshot));
      }
    } catch (cause) {
      // Key assignment, delta building, the watchdog and the publish into
      // Signal K itself all run here, and any of them can throw on a container
      // list the plugin did not expect. Contained per instance so that one
      // instance's surprise cannot silence the instance beside it.
      this.deps.log(
        `publishing instance ${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private builderFor(instance: string): DeltaBuilder {
    const existing = this.builders.get(instance);
    if (existing) return existing;
    const created = new DeltaBuilder(this.deps.pathPrefix, instance, this.deps.level);
    this.builders.set(instance, created);
    return created;
  }

  /**
   * One instance's containers, or an unreachable snapshot. A failure here is
   * data — "this instance is down" is exactly what the watchdog and the status
   * path need to say — so it is never allowed to reject.
   */
  private async snapshot(registry: InstanceRegistry, name: string): Promise<InstanceSnapshot> {
    try {
      const client = registry.get(name);
      const [containers, capabilities] = await Promise.all([
        client.docker.listContainers(true),
        client.capabilities().catch(() => undefined),
      ]);
      const snapshot: InstanceSnapshot = { reachable: true, containers: usable(containers) };
      if (capabilities?.dockerVersion) snapshot.version = capabilities.dockerVersion;
      return snapshot;
    } catch (cause) {
      const message = cause instanceof PortainerError ? cause.message : String(cause);
      this.deps.log(`poll of instance ${name} failed: ${message}`);
      return { reachable: false, containers: [], error: message };
    }
  }
}

/**
 * The containers in a response that can actually be published.
 *
 * `json<T>()` casts an untrusted body to the declared type without checking it,
 * so nothing upstream guarantees this is a list, or that an entry has the `Id`
 * every key and every sort below reads. A proxy, a captive portal or an agent
 * answering 200 with something else would otherwise throw deep inside the
 * poll. Dropping what cannot be keyed leaves the rest publishable.
 */
function usable(containers: DockerContainer[]): DockerContainer[] {
  if (!Array.isArray(containers)) return [];
  return containers.filter(
    (container): container is DockerContainer =>
      typeof container?.Id === 'string' && container.Id.length > 0,
  );
}

/**
 * The keys this snapshot's containers publish under, with the ids behind them,
 * so a PUT on a readable path can reach the right container.
 */
function describeKeys(snapshot: InstanceSnapshot): [string[], KeyedContainer[]] {
  const assigned = assignKeys(snapshot.containers);
  const containers: KeyedContainer[] = [];
  for (const container of snapshot.containers) {
    const key = assigned.get(container.Id)?.key;
    if (!key) continue;
    const name = container.Names?.[0]?.replace(/^\//, '');
    containers.push(name ? { key, id: container.Id, name } : { key, id: container.Id });
  }
  return [containers.map((entry) => entry.key), containers];
}
