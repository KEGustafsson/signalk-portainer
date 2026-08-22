import type { InstanceSnapshot } from './deltas';
import { assignKeys, joinPath, normalizeSegment } from './paths';
import type { DockerContainer } from './types';

/**
 * Containers that are supposed to be running, and the Signal K alarms raised
 * when they are not.
 *
 * This is the feature that justifies the plugin at 3am in an anchorage: the
 * chartplotter beeps when the AIS logger dies, instead of the crew finding a
 * gap in the track the next morning.
 */

export interface WatchEntry {
  instance: string;
  container: string;
}

export type AlarmState = 'normal' | 'alarm';

export interface Notification {
  path: string;
  value: { state: AlarmState; method: string[]; message: string };
}

/** Signal K's own convention: an active alarm asks for attention, a cleared one does not. */
function notification(state: AlarmState, message: string): Notification['value'] {
  return { state, method: state === 'alarm' ? ['visual', 'sound'] : [], message };
}

/**
 * Whether a configured watch names this container.
 *
 * Operators write what they know — the name they gave it in compose, the name
 * `docker ps` shows, or an id they copied — so all three are accepted rather
 * than making them discover which one the plugin wanted.
 */
function matches(container: DockerContainer, key: string, wanted: string): boolean {
  const target = wanted.trim();
  if (!target) return false;
  const normalized = normalizeSegment(target);
  if (key === normalized) return true;

  const name = container.Names?.[0]?.replace(/^\//, '');
  if (name && normalizeSegment(name) === normalized) return true;

  const id = target.toLowerCase();
  return id.length >= 6 && container.Id.toLowerCase().startsWith(id);
}

export class Watchdog {
  /** Last state published per path, so an alarm is raised once, not per poll. */
  private readonly states = new Map<string, AlarmState>();
  /**
   * The path each configured watch currently publishes to.
   *
   * A watch written as an id prefix resolves to the container's key while the
   * container exists, and to the configured string while it does not — two
   * different paths for one watch. Without remembering which one is in use, an
   * alarm raised on the second would still be standing after the container
   * came back and cleared the first.
   */
  private readonly paths = new Map<string, string>();

  constructor(
    private readonly prefix: string,
    private readonly entries: readonly WatchEntry[],
  ) {}

  /** True when nothing is being watched, so the poller can skip the work. */
  get idle(): boolean {
    return this.entries.length === 0;
  }

  /**
   * The notifications this poll changes. Only transitions are returned: an
   * alarm that is already raised does not need raising again every 30 seconds,
   * and Signal K keeps the last value for clients that connect later.
   */
  evaluate(instance: string, snapshot: InstanceSnapshot): Notification[] {
    const watched = this.entries.filter((entry) => entry.instance === instance);
    const notifications: Notification[] = [];

    const statusPath = joinPath('notifications', this.prefix, instance, 'status');
    if (!snapshot.reachable) {
      // The instance is unreachable, so nothing can be said about any container
      // on it. Alarming on each one would turn a network blip into a screen
      // full of alarms about containers that are probably running fine; the
      // instance alarm says the one true thing.
      this.push(
        notifications,
        statusPath,
        'alarm',
        `Portainer instance ${instance} is unreachable${snapshot.error ? ` — ${snapshot.error}` : ''}`,
      );
      return notifications;
    }

    this.push(notifications, statusPath, 'normal', `Portainer instance ${instance} is reachable`);
    if (watched.length === 0) return notifications;

    const keys = assignKeys(snapshot.containers);

    for (const entry of watched) {
      const found = snapshot.containers.find((container) =>
        matches(container, keys.get(container.Id)?.key ?? '', entry.container),
      );

      // While the container exists its own key names the path, so the alarm
      // sits beside the container's data paths. While it does not, the last
      // path used is kept — and the configured name only when there is none.
      const identity = `${entry.instance}/${entry.container}`;
      const previous = this.paths.get(identity);
      const resolved = found ? keys.get(found.Id)?.key : undefined;
      const path = resolved
        ? joinPath('notifications', this.prefix, instance, 'containers', resolved)
        : (previous ??
          joinPath(
            'notifications',
            this.prefix,
            instance,
            'containers',
            normalizeSegment(entry.container),
          ));

      // The watch moved paths — clear the one being abandoned, or its alarm
      // stands forever with nothing left to take it down.
      if (previous && previous !== path) {
        this.push(
          notifications,
          previous,
          'normal',
          `Container ${entry.container} is now reported under a different key`,
        );
        this.states.delete(previous);
      }
      this.paths.set(identity, path);

      if (!found) {
        // Missing is worse than stopped, not better: a container that was
        // removed will not come back on its own.
        this.push(
          notifications,
          path,
          'alarm',
          `Container ${entry.container} does not exist on ${instance}`,
        );
        continue;
      }

      if (found.State === 'running') {
        this.push(notifications, path, 'normal', `Container ${entry.container} is running`);
      } else {
        this.push(
          notifications,
          path,
          'alarm',
          `Container ${entry.container} is ${found.State} on ${instance}`,
        );
      }
    }

    return notifications;
  }

  /**
   * Clears every alarm this watchdog raised. A stopped plugin has no opinion
   * about anything, and leaving an alarm up that nobody is maintaining is worse
   * than leaving none.
   */
  clear(): Notification[] {
    const notifications: Notification[] = [];
    for (const [path, state] of this.states) {
      if (state !== 'alarm') continue;
      notifications.push({
        path,
        value: notification('normal', 'Watch stopped: the plugin is no longer checking'),
      });
    }
    this.states.clear();
    return notifications;
  }

  private push(into: Notification[], path: string, state: AlarmState, message: string): void {
    if (this.states.get(path) === state) return;
    this.states.set(path, state);
    into.push({ path, value: notification(state, message) });
  }
}
