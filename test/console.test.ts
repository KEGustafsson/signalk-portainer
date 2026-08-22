import { openConsole, ticketOf, type ConsoleEndpoint } from '../src/console';
import { RELAY_CLOSE, type RelaySocket } from '../src/execrelay';
import { ExecTickets } from '../src/exectickets';
import type { InstanceRegistry } from '../src/registry';
import { StreamLimiter } from '../src/streamlimit';

/** Either end of a relay, driven by the test. */
class FakeSocket implements RelaySocket {
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

  send(data: string | Uint8Array): void {
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
}

/** The endpoint `registerWebSocket` would have returned. */
class FakeEndpoint implements ConsoleEndpoint {
  connection: ((socket: RelaySocket, request: { url?: string }) => void) | undefined;
  closed = false;
  private errorListener: ((error: Error) => void) | undefined;

  on(event: 'connection' | 'error', listener: never): this {
    if (event === 'connection') {
      this.connection = listener as unknown as (
        socket: RelaySocket,
        request: { url?: string },
      ) => void;
    } else {
      this.errorListener = listener as unknown as (error: Error) => void;
    }
    return this;
  }

  close(): void {
    this.closed = true;
  }

  fail(error: Error): void {
    this.errorListener?.(error);
  }
}

describe('ticketOf', () => {
  it('reads the ticket out of the upgrade URL', () => {
    expect(ticketOf('/plugins/signalk-portainer/console?ticket=abc123')).toBe('abc123');
  });

  it('finds nothing where there is nothing', () => {
    expect(ticketOf(undefined)).toBeUndefined();
    expect(ticketOf('/plugins/signalk-portainer/console')).toBeUndefined();
    expect(ticketOf('/plugins/signalk-portainer/console?ticket=')).toBeUndefined();
    expect(ticketOf('/plugins/signalk-portainer/console?other=abc')).toBeUndefined();
  });
});

describe('openConsole', () => {
  const setup = (
    overrides: {
      connect?: () => RelaySocket | Promise<RelaySocket>;
      limits?: StreamLimiter;
      registry?: () => InstanceRegistry | undefined;
    } = {},
  ) => {
    const endpoint = new FakeEndpoint();
    const tickets = new ExecTickets();
    const upstream = new FakeSocket();
    const lines: string[] = [];
    const registry = {
      defaultName: 'boat',
      get: () => ({
        execSocket: async () => ({
          url: 'wss://boat.test:9443/api/websocket/exec?endpointId=1&id=exec-1',
          headers: { 'x-api-key': 'ptr_secret' },
          tls: undefined,
        }),
      }),
    } as unknown as InstanceRegistry;

    const server = openConsole({
      register: () => endpoint,
      tickets,
      registry: overrides.registry ?? (() => registry),
      log: (message) => lines.push(message),
      idleMs: 0,
      ...(overrides.limits ? { limits: overrides.limits } : {}),
      connect: overrides.connect ?? (() => upstream),
    });

    /** Connects a browser holding a ticket for this container. */
    const connect = async (ticket?: string): Promise<FakeSocket> => {
      const browser = new FakeSocket();
      endpoint.connection?.(browser, { url: `/console?ticket=${ticket ?? ''}` });
      // The handler is async; let it finish before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      return browser;
    };

    return { endpoint, tickets, upstream, lines, server, connect };
  };

  const grant = { instance: 'boat', execId: 'exec-1', containerId: 'c1f0e2a3b4c5d6e7' };

  it('joins the two sockets once a ticket is redeemed', async () => {
    const { tickets, upstream, connect } = setup();
    const browser = await connect(tickets.mint(grant));

    browser.emit('message', 'whoami\n');

    expect(browser.closed).toBeUndefined();
    expect(upstream.sent).toEqual(['whoami\n']);
  });

  it('refuses a socket with no ticket', async () => {
    // The cookie rides along on an upgrade and CORS does not stop one, so the
    // ticket is the only thing that authorises this.
    const { connect, upstream } = setup();

    const browser = await connect();

    expect(browser.closed?.code).toBe(RELAY_CLOSE.unauthorized);
    expect(upstream.sent).toHaveLength(0);
  });

  it('refuses a ticket that was already used', async () => {
    const { tickets, connect } = setup();
    const ticket = tickets.mint(grant);
    await connect(ticket);

    const second = await connect(ticket);

    expect(second.closed?.code).toBe(RELAY_CLOSE.unauthorized);
  });

  it('refuses a ticket nobody minted', async () => {
    const { connect } = setup();

    const browser = await connect('ticket-guessed');

    expect(browser.closed?.code).toBe(RELAY_CLOSE.unauthorized);
  });

  it('refuses once too many shells are open', async () => {
    const limits = new StreamLimiter({ total: 1, perTarget: 1 });
    const { tickets, connect } = setup({ limits });
    await connect(tickets.mint(grant));

    const second = await connect(tickets.mint(grant));

    expect(second.closed?.code).toBe(RELAY_CLOSE.refused);
  });

  it('frees the slot when a shell ends', async () => {
    const limits = new StreamLimiter({ total: 1, perTarget: 1 });
    const { tickets, connect } = setup({ limits });
    const first = await connect(tickets.mint(grant));

    first.emit('close');
    const second = await connect(tickets.mint(grant));

    expect(second.closed).toBeUndefined();
    expect(limits.openCount).toBe(1);
  });

  it('says so when Portainer cannot be reached', async () => {
    const { tickets, connect, lines } = setup({
      connect: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    const browser = await connect(tickets.mint(grant));

    expect(browser.closed?.code).toBe(RELAY_CLOSE.upstream);
    expect(lines.join('\n')).toContain('ECONNREFUSED');
  });

  it('refuses a socket that arrives before the plugin has a registry', async () => {
    const { tickets, connect } = setup({ registry: () => undefined });

    const browser = await connect(tickets.mint(grant));

    expect(browser.closed?.code).toBe(RELAY_CLOSE.refused);
  });

  it('ends every open shell when the plugin stops', async () => {
    const { tickets, connect, upstream, server, endpoint } = setup();
    const browser = await connect(tickets.mint(grant));

    server.close();

    // The endpoint closing terminates the browser sockets; the socket to
    // Portainer is only closed because the relay was ended first.
    expect(upstream.closed).toBeDefined();
    expect(browser.closed).toBeDefined();
    expect(endpoint.closed).toBe(true);
  });

  it('logs an endpoint error rather than throwing out of it', () => {
    const { endpoint, lines } = setup();

    endpoint.fail(new Error('listener exploded'));

    expect(lines.join('\n')).toContain('listener exploded');
  });
});
