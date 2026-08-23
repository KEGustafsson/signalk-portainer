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
      // Instances are polled together: a shore Portainer behind a slow link
      // must not delay the boat's own containers by its whole timeout.
      const snapshots = await Promise.all(
        registry.names.map(async (name) => ({
          name,
          snapshot: await this.snapshot(registry, name),
        })),
      );
      if (this.stopped) return;

      // Reported here rather than after publishing. Reachability is the one
      // thing this poll definitely learned, and everything below it can throw
      // — so leaving it to the end would let a delta-building failure freeze
      // the plugin status on a Portainer state that is no longer true. Its own
      // try, so a listener that throws cannot stop the telemetry either.
      try {
        this.deps.onHealth?.(
          snapshots.map(({ name, snapshot }) => ({
            name,
            reachable: snapshot.reachable,
            ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
          })),
        );
      } catch (cause) {
        this.deps.log(
          `reporting health failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const values: PathValue[] = [];
      const meta: MetaValue[] = [];
      const notifications: Notification[] = [];

      for (const { name, snapshot } of snapshots) {
        const built = this.builderFor(name).build(snapshot);
        values.push(...built.values);
        meta.push(...built.meta);

        if (this.deps.watchdog) {
          notifications.push(...this.deps.watchdog.evaluate(name, snapshot));
        }
        if (this.deps.onKeys && snapshot.reachable) {
          this.deps.onKeys(name, ...describeKeys(snapshot));
        }
      }

      if (values.length > 0 || meta.length > 0) this.deps.publish(values, meta);
      if (notifications.length > 0) this.deps.publishNotifications?.(notifications);
    } catch (cause) {
      // A poll must never be worse than a poll that reports "unreachable".
      // `snapshot()` already contains network failures; this catches everything
      // after it — key assignment, delta building, the watchdog, and the
      // publish into Signal K itself. Without it a rejection here is unhandled,
      // and Node ends the whole Signal K process: a container list the plugin
      // did not expect would take the boat's navigation data down with it.
      this.deps.log(`poll failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.polling = false;
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
