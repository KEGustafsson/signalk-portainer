import type { InstanceRegistry } from './registry';
import type { DockerEvent } from './types';

/**
 * Docker's event stream, turned into "go and look at this instance now".
 *
 * The poller asks every interval whether anything changed. That is the wrong
 * question on a boat: most intervals nothing has, and the ones where something
 * did are the ones the operator is waiting on. A container that dies at
 * 02:00:01 raised its alarm at 02:00:10 with a ten-second interval, and cost a
 * container listing across the radio link every ten seconds to find out.
 *
 * So Docker is asked to say so instead. This holds one idle connection per
 * instance and, when an event arrives that could have changed what the plugin
 * publishes, asks the poller to read that one instance now. The interval timer
 * stays exactly as it was: this is a prompt to look early, never the only
 * thing that looks. A stream that drops, an environment that cannot proxy one,
 * a Portainer too old — all of them degrade to the polling the plugin has
 * always done, which is why nothing here reports failure as a plugin error.
 */

/**
 * Actions worth a re-read.
 *
 * Docker emits far more than state changes — `exec_create` and `exec_start`
 * for every console keystroke's shell, `attach`, `top`, `archive-path`. Those
 * change nothing this plugin publishes, and re-listing containers for each one
 * would spend more of the link than the polling this replaces. Matched on the
 * part before the colon, because Docker writes health as
 * `health_status: healthy`.
 */
const WATCHED_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'destroy',
  'die',
  'health_status',
  'kill',
  'oom',
  'pause',
  'rename',
  'restart',
  'start',
  'stop',
  'unpause',
  'update',
]);

/**
 * How long a burst is allowed to settle before the re-read.
 *
 * Deploying a stack of six containers emits dozens of events in a second, and
 * each one would otherwise be its own container listing. Waiting this long
 * turns the burst into one read, at the cost of showing it a moment later than
 * the very first event could have.
 */
const SETTLE_MS = 400;

/** First reconnect delay, doubled per failure up to the ceiling. */
const RECONNECT_MS = 2_000;
const RECONNECT_CEILING_MS = 60_000;

/**
 * How long a stream has to stay open before it counts as working.
 *
 * A handshake that succeeds proves nothing: a proxy in front of Portainer can
 * answer 200 and close the body at once, and treating that as recovery reset
 * the backoff on every attempt — so the retry never slowed down past the first
 * step, and every cycle logged that events had "resumed" when nothing had.
 * Either an event arrives, or the stream holds this long; otherwise the outage
 * is still the same outage.
 */
const STABLE_MS = 30_000;

export interface ContainerEventsDeps {
  registry: () => InstanceRegistry | undefined;
  /** Read this instance now: something about it changed. */
  onChange: (instance: string) => void;
  log: (message: string) => void;
  /** Overridable so tests do not wait on real time. */
  settleMs?: number;
  reconnectMs?: number;
  stableMs?: number;
  /** Injectable clock, for the same reason. */
  now?: () => number;
}

/** One instance's subscription, and what it is waiting on. */
interface Subscription {
  controller: AbortController;
  settle?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  /** Consecutive failures, for the backoff. */
  failures: number;
  /** Logged once per outage rather than once per attempt. */
  quiet: boolean;
}

export class ContainerEvents {
  private readonly subscriptions = new Map<string, Subscription>();
  private stopped = false;

  constructor(private readonly deps: ContainerEventsDeps) {}

  /** Subscribes to every configured instance. Safe to call twice. */
  start(): void {
    if (this.stopped) return;
    const registry = this.deps.registry();
    if (!registry) return;
    for (const name of registry.names) {
      if (!this.subscriptions.has(name)) void this.follow(name);
    }
  }

  /**
   * Drops every subscription. Called before the registry closes, because an
   * open stream holds a client from it.
   */
  stop(): void {
    this.stopped = true;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.settle) clearTimeout(subscription.settle);
      if (subscription.retry) clearTimeout(subscription.retry);
      subscription.controller.abort();
    }
    this.subscriptions.clear();
  }

  /** Which instances currently hold a stream. Exposed for tests and status. */
  get following(): string[] {
    return [...this.subscriptions.keys()];
  }

  /**
   * Holds one instance's stream open, reconnecting for as long as the plugin
   * runs.
   *
   * Never rejects. A Portainer that is down, an environment with no Docker
   * behind it and a version without the route are all the same thing here: no
   * events, and the interval poll carries on alone.
   */
  private async follow(name: string): Promise<void> {
    const subscription: Subscription = {
      controller: new AbortController(),
      failures: 0,
      quiet: false,
    };
    this.subscriptions.set(name, subscription);

    const clock = this.deps.now ?? (() => Date.now());
    const stableMs = this.deps.stableMs ?? STABLE_MS;

    while (!this.stopped && this.subscriptions.get(name) === subscription) {
      // Not the handshake: a proxy can answer 200 and close the body at once,
      // and calling that recovery is what kept the backoff at its first step
      // forever. Recovery is an event, or a stream that stayed open.
      const openedAt = clock();
      let recovered = false;
      const working = (): void => {
        if (recovered) return;
        recovered = true;
        if (subscription.failures > 0) this.deps.log(`events on instance ${name} resumed`);
        subscription.failures = 0;
        subscription.quiet = false;
      };
      const heldOpen = (): void => {
        if (clock() - openedAt >= stableMs) working();
      };

      try {
        const registry = this.deps.registry();
        if (!registry) return;
        const events = await registry.get(name).docker.eventStream(subscription.controller.signal);
        for await (const event of events) {
          if (this.stopped) return;
          // An event is proof the subscription works, whatever it says.
          working();
          if (interesting(event)) this.settle(name, subscription);
        }
        // The stream ended without an error: Portainer restarted, or a proxy
        // closed an idle connection. Reconnect, but count it, so a stream that
        // ends immediately and forever does not become a hot loop.
        heldOpen();
        subscription.failures += 1;
      } catch (cause) {
        if (this.stopped || subscription.controller.signal.aborted) return;
        heldOpen();
        subscription.failures += 1;
        // Once per outage. An unreachable Portainer is already reported by the
        // poll and on the status line; repeating it here every two seconds
        // would bury the log the operator reads for anything else.
        if (!subscription.quiet) {
          subscription.quiet = true;
          this.deps.log(
            `events on instance ${name} unavailable, falling back to polling: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
      if (!(await this.pause(name, subscription))) return;
    }
  }

  /** The backoff between attempts. Resolves false when the wait was cut short. */
  private pause(name: string, subscription: Subscription): Promise<boolean> {
    const base = this.deps.reconnectMs ?? RECONNECT_MS;
    const delay = Math.min(RECONNECT_CEILING_MS, base * 2 ** Math.min(subscription.failures, 5));
    return new Promise((resolve) => {
      subscription.retry = setTimeout(() => {
        subscription.retry = undefined;
        resolve(!this.stopped && this.subscriptions.get(name) === subscription);
      }, delay);
      // A reconnect timer must never be the reason Signal K refuses to exit.
      subscription.retry.unref?.();
    });
  }

  /**
   * Coalesces a burst into one re-read.
   *
   * The timer is restarted by each event, so a stack coming up is read once
   * when it has finished coming up rather than once per container.
   */
  private settle(name: string, subscription: Subscription): void {
    if (subscription.settle) clearTimeout(subscription.settle);
    subscription.settle = setTimeout(() => {
      subscription.settle = undefined;
      if (this.stopped) return;
      try {
        this.deps.onChange(name);
      } catch (cause) {
        // A listener that throws must not end the subscription: the next
        // event would then never be seen, and the plugin would be back to
        // polling with no sign of why.
        this.deps.log(
          `reading instance ${name} after an event failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }, this.deps.settleMs ?? SETTLE_MS);
    subscription.settle.unref?.();
  }
}

/** Whether this event could have changed something the plugin publishes. */
export function interesting(event: DockerEvent): boolean {
  if (event.Type !== undefined && event.Type !== 'container') return false;
  const action = event.Action;
  if (typeof action !== 'string') return false;
  // `health_status: healthy` and `exec_create: sh -c …` both carry their
  // argument after a colon; only the verb decides.
  const verb = action.split(':')[0]?.trim() ?? '';
  return WATCHED_ACTIONS.has(verb);
}
