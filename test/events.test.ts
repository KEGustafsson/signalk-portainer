import { ContainerEvents, interesting } from '../src/events';
import type { InstanceRegistry } from '../src/registry';
import type { DockerEvent } from '../src/types';

/**
 * The event stream is a prompt, never the source of truth: everything it does
 * is ask the poller to read one instance early. So these tests are about what
 * is worth asking for, how a burst is collapsed into one ask, and what happens
 * when the stream is not there — which on a boat is most of the interesting
 * cases.
 */

/** A stream the test feeds by hand, and can end or fail on demand. */
class FakeStream {
  private readonly queue: DockerEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;

  push(event: DockerEvent): void {
    this.queue.push(event);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  fail(error: Error): void {
    this.failure = error;
    this.wake?.();
  }

  async *iterate(): AsyncIterable<DockerEvent> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift() as DockerEvent;
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/** Lets the microtask queue drain, which is how the subscription advances. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('interesting', () => {
  it('takes the container states the plugin publishes', () => {
    for (const action of ['start', 'die', 'stop', 'kill', 'pause', 'unpause', 'destroy']) {
      expect(interesting({ Type: 'container', Action: action })).toBe(true);
    }
  });

  it('reads the verb of an action that carries an argument', () => {
    // Docker writes health as `health_status: healthy`, and the argument is
    // not what decides — a container that just became unhealthy and one that
    // just became healthy are both worth a re-read.
    expect(interesting({ Type: 'container', Action: 'health_status: unhealthy' })).toBe(true);
    expect(interesting({ Type: 'container', Action: 'health_status: healthy' })).toBe(true);
  });

  it('ignores the ones a console session makes for every keystroke', () => {
    // `exec_create` and `exec_start` fire whenever someone opens a shell.
    // Re-listing containers for those would spend more of the link than the
    // polling this replaces.
    expect(interesting({ Type: 'container', Action: 'exec_create: sh' })).toBe(false);
    expect(interesting({ Type: 'container', Action: 'exec_start: sh -c ls' })).toBe(false);
    expect(interesting({ Type: 'container', Action: 'attach' })).toBe(false);
    expect(interesting({ Type: 'container', Action: 'top' })).toBe(false);
  });

  it('ignores anything that is not a container, and anything malformed', () => {
    expect(interesting({ Type: 'image', Action: 'pull' })).toBe(false);
    expect(interesting({ Type: 'network', Action: 'connect' })).toBe(false);
    expect(interesting({ Type: 'container' })).toBe(false);
    expect(interesting({})).toBe(false);
  });
});

describe('ContainerEvents', () => {
  let streams: FakeStream[];
  let opened: string[];
  let changed: string[];
  let logs: string[];
  let watcher: ContainerEvents | undefined;

  beforeEach(() => {
    streams = [];
    opened = [];
    changed = [];
    logs = [];
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  /** A registry whose every instance hands back a stream the test drives. */
  const registryOf = (names: string[], open?: (name: string) => AsyncIterable<DockerEvent>) =>
    ({
      names,
      get: (name: string) => ({
        docker: {
          eventStream: () => {
            opened.push(name);
            if (open) return Promise.resolve(open(name));
            const stream = new FakeStream();
            streams.push(stream);
            return Promise.resolve(stream.iterate());
          },
        },
      }),
    }) as unknown as InstanceRegistry;

  const build = (
    registry: InstanceRegistry | undefined,
    settleMs = 1,
    extra: { stableMs?: number; now?: () => number } = {},
  ) => {
    watcher = new ContainerEvents({
      registry: () => registry,
      onChange: (instance) => changed.push(instance),
      log: (message) => logs.push(message),
      settleMs,
      reconnectMs: 1,
      ...extra,
    });
    return watcher;
  };

  it('follows every configured instance', async () => {
    build(registryOf(['boat', 'shore'])).start();
    await settle();

    expect(opened.sort()).toEqual(['boat', 'shore']);
  });

  it('collapses the burst a stack deploy makes into one read', async () => {
    // Six containers coming up is dozens of events in a second. One read when
    // it has finished is the point; one read per event would cost more of the
    // link than the polling this replaces.
    build(registryOf(['boat']), 20).start();
    await settle();

    for (const action of ['create', 'start', 'create', 'start', 'health_status: healthy']) {
      streams[0]?.push({ Type: 'container', Action: action });
    }
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(changed).toEqual(['boat']);
  });

  it('does not read for an event that changed nothing it publishes', async () => {
    build(registryOf(['boat'])).start();
    await settle();

    streams[0]?.push({ Type: 'container', Action: 'exec_start: sh' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(changed).toEqual([]);
  });

  it('falls back to polling when the stream cannot be opened, and says so once', async () => {
    // An environment with no Docker behind it, a Portainer that is down, a
    // version without the route: all the same thing here. The interval poll
    // carries on, so this is a log line rather than a plugin error — and one
    // line, not one every two seconds.
    build(
      registryOf(['boat'], () => {
        throw new Error('connect ECONNREFUSED');
      }),
    ).start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(changed).toEqual([]);
    expect(logs.filter((line) => line.includes('falling back to polling'))).toHaveLength(1);
    expect(opened.length).toBeGreaterThan(1);
  });

  it('reconnects when the stream ends on its own', async () => {
    // Portainer restarting, or a proxy closing an idle connection. Neither is
    // a reason to stop watching for the rest of the voyage.
    build(registryOf(['boat'])).start();
    await settle();
    expect(opened).toEqual(['boat']);

    streams[0]?.end();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(opened.length).toBeGreaterThan(1);
  });

  it('reconnects when the stream fails part-way through', async () => {
    // A connection reset mid-stream, which on a boat is what a radio link
    // does. The events after it still have to arrive.
    build(registryOf(['boat'])).start();
    await settle();

    streams[0]?.fail(new Error('socket hang up'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(opened.length).toBeGreaterThan(1);

    streams[streams.length - 1]?.push({ Type: 'container', Action: 'die' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changed).toEqual(['boat']);
  });

  it('does not call a stream that closes at once a recovery', async () => {
    // A proxy in front of Portainer can answer 200 and close the body
    // immediately. Treating the handshake as recovery reset the backoff every
    // cycle — so the retry never slowed down — and logged that events had
    // "resumed" each time, when nothing had.
    build(
      registryOf(['boat'], () => {
        const stream = new FakeStream();
        streams.push(stream);
        stream.end();
        return stream.iterate();
      }),
      1,
      { stableMs: 10_000 },
    ).start();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(opened.length).toBeGreaterThan(2);
    expect(logs.filter((line) => line.includes('resumed'))).toEqual([]);
  });

  it('counts a stream that stayed open as recovery when it finally drops', async () => {
    // The other side of it: a subscription that ran for hours and then fell
    // over is a new outage, and its reconnect starts from the bottom of the
    // backoff rather than wherever the last one left off.
    let clock = 0;
    build(registryOf(['boat'], undefined), 1, { stableMs: 50, now: () => clock }).start();
    await settle();

    // It failed once before, so the state is mid-outage.
    streams[0]?.fail(new Error('socket hang up'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.filter((line) => line.includes('falling back'))).toHaveLength(1);

    // The replacement holds open well past the stability mark, then drops.
    clock += 1_000;
    streams[streams.length - 1]?.fail(new Error('socket hang up again'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(logs.filter((line) => line.includes('resumed'))).toHaveLength(1);
    // A new outage, so it is reported again rather than staying quiet.
    expect(logs.filter((line) => line.includes('falling back'))).toHaveLength(2);
  });

  it('stops following once the plugin stops', async () => {
    const events = build(registryOf(['boat']));
    events.start();
    await settle();
    expect(events.following).toEqual(['boat']);

    events.stop();
    streams[0]?.push({ Type: 'container', Action: 'die' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events.following).toEqual([]);
    expect(changed).toEqual([]);
  });

  it('does nothing at all without a registry', async () => {
    build(undefined).start();
    await settle();

    expect(opened).toEqual([]);
  });

  it('keeps watching when the read it asked for throws', async () => {
    // The poller contains its own failures, but a listener that throws must
    // not end the subscription: the next event would never be seen and the
    // plugin would be back to polling with nothing saying why.
    watcher = new ContainerEvents({
      registry: () => registryOf(['boat']),
      onChange: () => {
        throw new Error('publish failed');
      },
      log: (message) => logs.push(message),
      settleMs: 1,
      reconnectMs: 1,
    });
    watcher.start();
    await settle();

    streams[0]?.push({ Type: 'container', Action: 'die' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    streams[0]?.push({ Type: 'container', Action: 'start' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(logs.filter((line) => line.includes('after an event failed'))).toHaveLength(2);
    expect(watcher.following).toEqual(['boat']);
  });
});
