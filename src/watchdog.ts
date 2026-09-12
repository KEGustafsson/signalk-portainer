import type { InstanceSnapshot } from './deltas';
import { assignKeys, joinPath, matchesContainerRef, normalizeSegment } from './paths';

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

/**
 * Signal K's own convention: an active alarm asks for attention, a cleared
 * one does not. A paused container is the one alarm that stays silent — it
 * was paused by someone, from the panel as often as not, and a chartplotter
 * sounding over an operator's own action teaches them to mute the channel.
 */
function notification(
  state: AlarmState,
  message: string,
  method: string[] = state === 'alarm' ? ['visual', 'sound'] : [],
): Notification['value'] {
  return { state, method, message };
}

/**
 * How many consecutive failed polls before an instance is called unreachable.
 * Two, so a single dropped packet is not an alarm but a real outage still is,
 * one interval later.
 */
const UNREACHABLE_POLLS = 2;

/**
 * Two polls in a row before the *transient* container states are alarmed.
 *
 * A `docker compose up` takes a service away and puts it back between two
 * polls, and a container with a restart policy cycles through `restarting`
 * and `created` on its way to running — so alarming the first time one of
 * those is seen raises and clears an alarm every interval for something
 * nobody can act on, which is how a crew learns to ignore the channel.
 *
 * Only those. A container that has exited, died, been paused or gone
 * unhealthy is not on its way anywhere, and waiting a second interval to say
 * so would be a minute of silence on the one alarm that matters.
 */
const TRANSIENT_STATES: readonly string[] = ['restarting', 'created', 'removing'];
const CONTAINER_DOWN_POLLS = 2;

export class Watchdog {
  /** Last state published per path, so an alarm is raised once, not per poll. */
  private readonly states = new Map<string, AlarmState>();
  /**
   * What was last published for a path, as the whole notification rather than
   * its state. Deduplicating on the state alone held back everything that
   * changes while an alarm stays an alarm: a container that went from exited
   * to paused kept the sound method it no longer wanted, and one that went
   * from stopped to removed went on saying it was stopped.
   */
  private readonly published = new Map<string, string>();
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
  /** Consecutive failed polls per instance, so a blip does not alarm. */
  private readonly misses = new Map<string, number>();
  /** Consecutive polls each watched container was seen not running. */
  private readonly downPolls = new Map<string, number>();

  evaluate(instance: string, snapshot: InstanceSnapshot): Notification[] {
    const watched = this.entries.filter((entry) => entry.instance === instance);
    const notifications: Notification[] = [];

    const statusPath = joinPath('notifications', this.prefix, instance, 'status');
    if (!snapshot.reachable) {
      // The instance is unreachable, so nothing can be said about any container
      // on it. Alarming on each one would turn a network blip into a screen
      // full of alarms about containers that are probably running fine; the
      // instance alarm says the one true thing.
      //
      // And not on the first failure. A shore Portainer over a marina or LTE
      // link fails a poll now and then; alarming on one dropped packet would
      // sound the chartplotter through the night, and an operator who is woken
      // by a false alarm learns to ignore the channel that raised it.
      const misses = (this.misses.get(instance) ?? 0) + 1;
      this.misses.set(instance, misses);
      if (misses < UNREACHABLE_POLLS) return notifications;

      this.push(
        notifications,
        statusPath,
        'alarm',
        `Portainer instance ${instance} is unreachable${snapshot.error ? ` — ${snapshot.error}` : ''}`,
      );
      return notifications;
    }

    // One good poll clears it: coming back is not something to be cautious
    // about.
    this.misses.delete(instance);
    this.push(notifications, statusPath, 'normal', `Portainer instance ${instance} is reachable`);
    if (watched.length === 0) return notifications;

    const keys = assignKeys(snapshot.containers);

    for (const entry of watched) {
      const found = snapshot.containers.find((container) =>
        matchesContainerRef(container, keys.get(container.Id)?.key ?? '', entry.container),
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
        this.published.delete(previous);
      }
      this.paths.set(identity, path);

      // Running, and not failing its own health check. Docker keeps a
      // container whose healthcheck fails in the running state — the process
      // is alive, it just no longer does its job — and that is precisely the
      // hung AIS logger this watchdog exists to catch.
      const unhealthy = found ? /\(unhealthy\)/i.test(found.Status ?? '') : false;
      if (found && found.State === 'running' && !unhealthy) {
        this.downPolls.delete(identity);
        this.push(notifications, path, 'normal', `Container ${entry.container} is running`);
        continue;
      }

      // A state a container passes through, or an absence a recreate
      // explains, is given one more poll to resolve itself. Everything else
      // is alarmed at once.
      const down = (this.downPolls.get(identity) ?? 0) + 1;
      this.downPolls.set(identity, down);
      const transient = !found || TRANSIENT_STATES.includes(found.State);
      if (transient && down < CONTAINER_DOWN_POLLS) continue;

      if (!found) {
        // Missing is worse than stopped, not better: a container that was
        // removed will not come back on its own.
        this.push(
          notifications,
          path,
          'alarm',
          `Container ${entry.container} does not exist on ${instance}`,
        );
      } else if (unhealthy) {
        this.push(
          notifications,
          path,
          'alarm',
          `Container ${entry.container} is running but unhealthy on ${instance}`,
        );
      } else {
        this.push(
          notifications,
          path,
          'alarm',
          `Container ${entry.container} is ${found.State} on ${instance}`,
          found.State === 'paused' ? ['visual'] : undefined,
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
    this.published.clear();
    return notifications;
  }

  private push(
    into: Notification[],
    path: string,
    state: AlarmState,
    message: string,
    method?: string[],
  ): void {
    const value = notification(state, message, method);
    const signature = JSON.stringify(value);
    if (this.published.get(path) === signature) return;
    this.states.set(path, state);
    this.published.set(path, signature);
    into.push({ path, value });
  }
}
