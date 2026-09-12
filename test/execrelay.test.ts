import { relay, RELAY_CLOSE, type RelaySocket } from '../src/execrelay';

/** A socket the test drives, standing in for either end of the relay. */
class FakeSocket implements RelaySocket {
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | undefined;
  /** What `ws` has queued for a peer it cannot write to fast enough. */
  bufferedAmount = 0;
  paused = false;
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  send(data: string | Uint8Array): void {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed ??= { code, reason };
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }

  get text(): string {
    return this.sent
      .map((part) => (typeof part === 'string' ? part : Buffer.from(part).toString()))
      .join('');
  }
}

/**
 * A socket that also offers the optional `ws` methods.
 *
 * Kept apart from `FakeSocket` on purpose: the heartbeat only arms when the
 * browser can ping, so giving every socket these would start a timer in every
 * test above rather than only where one is being tested.
 */
class PingableSocket extends FakeSocket {
  pings = 0;
  terminated = false;

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('relay', () => {
  const pair = (options: Parameters<typeof relay>[2] = {}) => {
    const browser = new FakeSocket();
    const upstream = new FakeSocket();
    const end = relay(browser, upstream, { idleMs: 0, ...options });
    return { browser, upstream, end };
  };

  it('carries what the operator types to the shell', () => {
    const { browser, upstream } = pair();

    browser.emit('message', 'ls -la\n');

    expect(upstream.text).toBe('ls -la\n');
  });

  it('carries what the shell prints back', () => {
    const { browser, upstream } = pair();

    upstream.emit('message', Buffer.from('total 0\r\n'));

    expect(browser.text).toBe('total 0\r\n');
  });

  it('joins a fragmented message rather than dropping the pieces', () => {
    const { browser, upstream } = pair();

    upstream.emit('message', [Buffer.from('half '), Buffer.from('a line')]);

    expect(browser.text).toBe('half a line');
  });

  it('passes an ArrayBuffer through as bytes', () => {
    const { browser, upstream } = pair();

    upstream.emit('message', new TextEncoder().encode('bytes').buffer);

    expect(browser.text).toBe('bytes');
  });

  it('holds back whichever sender is outrunning its receiver, in either direction', () => {
    // One drain timer belonged to whichever direction congested first, and the
    // other could then never pause its own sender: it ran on to the hard
    // limit and closed a console that flow control would have recovered.
    const { browser, upstream, end } = pair();

    upstream.bufferedAmount = 2 * 1024 * 1024;
    browser.emit('message', 'a very long paste');
    expect(browser.paused).toBe(true);

    browser.bufferedAmount = 2 * 1024 * 1024;
    upstream.emit('message', 'a very long build log');
    expect(upstream.paused).toBe(true);

    // Both drain timers belong to the relay, and end clears them.
    end();
  });

  it('always sends a close code, so the reason reaches the browser', () => {
    // `ws` discards the reason when the code is undefined, so the peer saw a
    // bare 1005 and the panel's handling of the reason never ran.
    const { browser, end } = pair();

    end();

    expect(browser.closed).toEqual({
      code: RELAY_CLOSE.normal,
      reason: 'the plugin stopped',
    });
  });

  it('sends a code with the reason when the shell exits', () => {
    const { browser, upstream } = pair();

    upstream.emit('close');

    expect(browser.closed?.code).toBe(RELAY_CLOSE.normal);
    expect(browser.closed?.reason).toBe('the shell ended');
  });

  it('ends both sides when the browser closes', () => {
    // A shell whose browser has gone still holds a process in the container.
    const ended: string[] = [];
    const { browser, upstream } = pair({ onEnd: (reason) => ended.push(reason) });

    browser.emit('close');

    expect(upstream.closed).toBeDefined();
    expect(ended).toEqual(['the browser closed the console']);
  });

  it('ends both sides when the shell exits', () => {
    const { browser, upstream } = pair();

    upstream.emit('close');

    expect(browser.closed).toBeDefined();
  });

  it('ends both sides on an error from either', () => {
    const first = pair();
    first.upstream.emit('error', new Error('connection reset'));
    expect(first.browser.closed?.code).toBe(RELAY_CLOSE.upstream);

    const second = pair();
    second.browser.emit('error', new Error('gone'));
    expect(second.upstream.closed).toBeDefined();
  });

  it('reports the end exactly once, however many ways it ends', () => {
    const ended: string[] = [];
    const { browser, upstream } = pair({ onEnd: (reason) => ended.push(reason) });

    browser.emit('close');
    upstream.emit('close');
    browser.emit('error', new Error('late'));

    expect(ended).toHaveLength(1);
  });

  it('stops carrying traffic once it has ended', () => {
    const { browser, upstream } = pair();
    browser.emit('close');

    // Sending on a closed socket would throw; the relay must not try.
    expect(() => upstream.emit('message', 'output after close')).not.toThrow();
    expect(browser.sent).toHaveLength(0);
  });

  it('can be ended from outside, for a plugin that is stopping', () => {
    const ended: string[] = [];
    const { browser, upstream, end } = pair({ onEnd: (reason) => ended.push(reason) });

    end();

    expect(browser.closed).toBeDefined();
    expect(upstream.closed).toBeDefined();
    expect(ended).toEqual(['the plugin stopped']);
  });

  it('refuses a message too large to relay rather than carrying it', () => {
    // One message is bounded on its own as well as by the queue behind it: a
    // peer that sends a megabyte in a single frame gets there before
    // bufferedAmount has anything to say about it.
    const { browser, upstream } = pair();

    browser.emit('message', 'x'.repeat(1024 * 1024 + 1));

    expect(upstream.sent).toHaveLength(0);
    expect(browser.closed?.code).toBe(RELAY_CLOSE.refused);
    expect(browser.closed?.reason).toBe('a message was too large to relay');
  });

  it('gives up on a receiver that is already past the hard limit', () => {
    // Past this there is no recovering by pausing: the queue is the heap.
    const { browser, upstream } = pair();

    upstream.bufferedAmount = 9 * 1024 * 1024;
    browser.emit('message', 'more');

    expect(browser.closed?.code).toBe(RELAY_CLOSE.refused);
    expect(browser.closed?.reason).toBe('the other end could not keep up');
  });

  it('stringifies a message that is neither text nor bytes', () => {
    // Swallowing a keystroke is worse than sending something odd.
    const { browser, upstream } = pair();

    browser.emit('message', 42);

    expect(upstream.sent).toEqual(['42']);
  });

  it('says so when Portainer closes for its own reasons', () => {
    // The agent lost, Docker restarted, the proxy giving up: reporting that as
    // the shell exiting sends the operator to open another one that fails the
    // same way.
    const { browser, upstream } = pair();

    upstream.emit('close', 1006);

    expect(browser.closed?.code).toBe(RELAY_CLOSE.upstream);
    expect(browser.closed?.reason).toBe('the connection to Portainer closed (1006)');
  });

  describe('back pressure', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('lets the sender go again once the receiver has drained', () => {
      const { browser, upstream, end } = pair();

      upstream.bufferedAmount = 2 * 1024 * 1024;
      browser.emit('message', 'a very long paste');
      expect(browser.paused).toBe(true);

      // Still above the low mark: pausing has not achieved anything yet.
      upstream.bufferedAmount = 512 * 1024;
      jest.advanceTimersByTime(200);
      expect(browser.paused).toBe(true);

      upstream.bufferedAmount = 1024;
      jest.advanceTimersByTime(200);
      expect(browser.paused).toBe(false);

      end();
    });

    it('ends the console when a paused receiver keeps growing anyway', () => {
      // Pausing the sender is the recovery; a queue that grows through it
      // means the receiver is gone rather than slow.
      const { browser, upstream } = pair();

      upstream.bufferedAmount = 2 * 1024 * 1024;
      browser.emit('message', 'a very long paste');
      expect(browser.paused).toBe(true);

      upstream.bufferedAmount = 9 * 1024 * 1024;
      jest.advanceTimersByTime(200);

      expect(browser.closed?.code).toBe(RELAY_CLOSE.refused);
      expect(browser.closed?.reason).toBe('the other end could not keep up');
    });
  });

  describe('the heartbeat', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const pingable = (heartbeatMs: number) => {
      const browser = new PingableSocket();
      const upstream = new PingableSocket();
      const end = relay(browser, upstream, { idleMs: 0, heartbeatMs });
      return { browser, upstream, end };
    };

    it('asks both ends whether they are still there', () => {
      const { browser, upstream, end } = pingable(1000);

      jest.advanceTimersByTime(1001);

      expect(browser.pings).toBe(1);
      expect(upstream.pings).toBe(1);
      end();
    });

    it('keeps a console that answers', () => {
      const { browser, upstream, end } = pingable(1000);

      for (let round = 0; round < 4; round += 1) {
        jest.advanceTimersByTime(1001);
        browser.emit('pong');
        upstream.emit('pong');
      }

      expect(browser.closed).toBeUndefined();
      end();
    });

    it('terminates a half-open connection that answers nothing', () => {
      // close() waits for a FIN that a vanished peer will never send, which is
      // how these were held open; terminate is what actually reclaims it.
      const { browser } = pingable(1000);

      jest.advanceTimersByTime(1001);
      jest.advanceTimersByTime(1001);

      expect(browser.terminated).toBe(true);
      expect(browser.closed?.code).toBe(RELAY_CLOSE.upstream);
      expect(browser.closed?.reason).toBe('the connection stopped answering');
    });
  });

  describe('the idle timeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('ends a shell nobody is using', () => {
      // A forgotten shell holds a process in the container as well as two
      // sockets.
      const { browser } = pair({ idleMs: 1000 });

      jest.advanceTimersByTime(1001);

      expect(browser.closed?.code).toBe(RELAY_CLOSE.idle);
    });

    it('counts typing as use', () => {
      const { browser } = pair({ idleMs: 1000 });

      jest.advanceTimersByTime(900);
      browser.emit('message', 'x');
      jest.advanceTimersByTime(900);
      browser.emit('message', 'x');
      jest.advanceTimersByTime(900);

      expect(browser.closed).toBeUndefined();
    });

    it('does not count output alone as use', () => {
      // Output used to restart the countdown, and there is no ping/pong on
      // this path: a shell printing continuously to a browser that vanished
      // without a FIN was never idle, so it held a process in the container
      // and an outbound buffer that only grew.
      const { browser, upstream } = pair({ idleMs: 1000 });

      for (let elapsed = 0; elapsed < 1200; elapsed += 300) {
        upstream.emit('message', 'still printing\n');
        jest.advanceTimersByTime(300);
      }

      expect(browser.closed?.code).toBe(RELAY_CLOSE.idle);
    });

    it('is off when the timeout is zero', () => {
      const { browser } = pair({ idleMs: 0 });

      jest.advanceTimersByTime(60 * 60_000);

      expect(browser.closed).toBeUndefined();
    });
  });
});
