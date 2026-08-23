import { relay, RELAY_CLOSE, type RelaySocket } from '../src/execrelay';

/** A socket the test drives, standing in for either end of the relay. */
class FakeSocket implements RelaySocket {
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

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
