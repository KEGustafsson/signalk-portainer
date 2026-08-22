import type { TelemetryLevel } from './config';
import { assignKeys, joinPath, parseHealth } from './paths';
import type { DockerContainer } from './types';

/**
 * Turning a poll of one Portainer instance into Signal K deltas.
 *
 * Pure by design: the poller decides when to look, this decides what to say,
 * and the tests can assert the exact deltas without a server or a clock.
 */

export interface PathValue {
  path: string;
  value: unknown;
}

export interface MetaValue {
  path: string;
  value: { units?: string; displayName?: string; description?: string };
}

export interface InstanceSnapshot {
  reachable: boolean;
  version?: string;
  containers: DockerContainer[];
  /** Present when the poll failed; containers is then empty. */
  error?: string;
}

/**
 * Suffixes published at each level, in publication order. `health` carries only
 * what a dashboard or the watchdog reads; `full` adds the identifying strings,
 * which never change and cost bandwidth on every poll.
 */
const SUFFIXES: Record<Exclude<TelemetryLevel, 'off'>, readonly string[]> = {
  health: ['state', 'health'],
  full: ['state', 'health', 'image', 'name', 'id'],
};

/** Every suffix any level can publish, for clearing a container that is gone. */
const ALL_SUFFIXES = SUFFIXES.full;

/** Everything published for one container, keyed by path suffix. */
function containerValues(container: DockerContainer): Record<string, unknown> {
  const name = container.Names?.[0]?.replace(/^\//, '');
  return {
    state: container.State,
    // undefined for a container with no healthcheck; dropped below rather than
    // published as null, which would read as "unhealthy" in a dashboard.
    health: parseHealth(container.Status),
    image: container.Image,
    name,
    id: container.Id.slice(0, 12),
  };
}

const META: Record<string, MetaValue['value']> = {
  'status.reachable': {
    displayName: 'Portainer reachable',
    description: 'Whether the plugin could reach this Portainer instance on its last poll',
  },
  'status.containersRunning': {
    displayName: 'Containers running',
    description: 'Containers in the running state on this environment',
  },
  'status.containersTotal': {
    displayName: 'Containers total',
    description: 'Containers known to this environment, running or not',
  },
  'containers.state': {
    displayName: 'State',
    description: 'Docker container state: running, exited, paused, restarting, created or dead',
  },
  'containers.health': {
    displayName: 'Health',
    description: "The container healthcheck's verdict: healthy, unhealthy or starting",
  },
  'containers.uptime': {
    units: 's',
    displayName: 'Uptime',
    description: 'Seconds since the container last started',
  },
};

/**
 * Tracks what was published last time, so a container that disappears can be
 * cleared instead of leaving a dashboard showing a gauge for something that no
 * longer exists.
 *
 * One instance of this per configured Portainer instance.
 */
export class DeltaBuilder {
  /** Container keys published on the previous poll. */
  private published = new Set<string>();
  /** Paths that have already had their meta delta sent. */
  private readonly metaSent = new Set<string>();

  constructor(
    private readonly prefix: string,
    private readonly instance: string,
    /** Which suffixes to publish; 'off' never reaches here. */
    private readonly level: Exclude<TelemetryLevel, 'off'> = 'full',
  ) {}

  private base(): string {
    return joinPath(this.prefix, this.instance);
  }

  /**
   * The values for one poll, plus the meta for any path published here for the
   * first time.
   */
  build(snapshot: InstanceSnapshot): { values: PathValue[]; meta: MetaValue[] } {
    const values: PathValue[] = [];
    const meta: MetaValue[] = [];

    const addMeta = (path: string, key: string): void => {
      const definition = META[key];
      if (!definition || this.metaSent.has(path)) return;
      this.metaSent.add(path);
      meta.push({ path, value: definition });
    };

    const status = joinPath(this.base(), 'status');
    values.push({ path: joinPath(status, 'reachable'), value: snapshot.reachable });
    addMeta(joinPath(status, 'reachable'), 'status.reachable');
    if (snapshot.version) {
      values.push({ path: joinPath(status, 'version'), value: snapshot.version });
    }

    // An unreachable instance publishes its status and stops there. Reporting
    // zero containers would be a claim about the environment that this poll has
    // no basis for — silence on those paths is the honest answer, and the
    // watchdog reads `reachable` rather than the count.
    if (!snapshot.reachable) {
      return { values, meta };
    }

    const running = snapshot.containers.filter((container) => container.State === 'running').length;
    values.push({ path: joinPath(status, 'containersRunning'), value: running });
    addMeta(joinPath(status, 'containersRunning'), 'status.containersRunning');
    values.push({ path: joinPath(status, 'containersTotal'), value: snapshot.containers.length });
    addMeta(joinPath(status, 'containersTotal'), 'status.containersTotal');

    const keys = assignKeys(snapshot.containers);
    const seen = new Set<string>();

    for (const container of snapshot.containers) {
      const assigned = keys.get(container.Id);
      if (!assigned) continue;
      seen.add(assigned.key);
      const root = joinPath(this.base(), 'containers', assigned.key);

      const available = containerValues(container);
      for (const suffix of SUFFIXES[this.level]) {
        const value = available[suffix];
        if (value === undefined) continue;
        const path = joinPath(root, suffix);
        values.push({ path, value });
        addMeta(path, `containers.${suffix}`);
      }
    }

    // Gone since the last poll: published once as null so a dashboard clears,
    // then forgotten so it is not republished forever.
    for (const key of this.published) {
      if (seen.has(key)) continue;
      const root = joinPath(this.base(), 'containers', key);
      // Cleared across every suffix, not just this level's: the level can have
      // been turned down since those paths were published.
      for (const suffix of ALL_SUFFIXES) {
        values.push({ path: joinPath(root, suffix), value: null });
      }
    }

    this.published = seen;
    return { values, meta };
  }

  /**
   * Clears every container path this builder has published, for plugin
   * shutdown: leaving the last poll's values in the data model would show a
   * running container long after the plugin stopped watching it.
   */
  clear(): PathValue[] {
    const values: PathValue[] = [];
    for (const key of this.published) {
      const root = joinPath(this.base(), 'containers', key);
      for (const suffix of ALL_SUFFIXES) {
        values.push({ path: joinPath(root, suffix), value: null });
      }
    }
    values.push({ path: joinPath(this.base(), 'status', 'reachable'), value: null });
    this.published = new Set();
    return values;
  }
}
