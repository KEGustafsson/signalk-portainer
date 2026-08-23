/**
 * The WebSocket endpoint a console connects to.
 *
 * The browser arrives here holding a ticket it got from an authenticated POST.
 * This redeems it, opens the matching socket to Portainer, and hands both to
 * the relay. Nothing else about the request is trusted: not the cookie, which
 * CORS does not protect on an upgrade, and not the query beyond the ticket
 * itself, since the ticket already says which container it is for.
 */

import { WebSocket } from 'ws';
import type { PortainerClient } from './client';
import { relay, RELAY_CLOSE, type RelaySocket } from './execrelay';
import type { ConsoleSessions } from './consolesessions';
import type { ExecTickets } from './exectickets';
import type { InstanceRegistry } from './registry';
import { StreamLimiter, StreamLimitError } from './streamlimit';

/**
 * The path the endpoint is registered at, under the plugin's own route.
 *
 * The browser opens the absolute form of this, which the webapp holds as
 * `CONSOLE_URL` — a different name on purpose, so a reader can tell the two
 * apart.
 */
export const CONSOLE_MOUNT = '/console';

/** What `registerWebSocket` gives back, narrowed to what this uses. */
export interface ConsoleEndpoint {
  on(
    event: 'connection',
    listener: (socket: RelaySocket, request: { url?: string }) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(cb?: (err?: Error) => void): void;
}

export interface ConsoleServer {
  close(): void;
}

/** Everything needed to reach Portainer's exec socket, TLS included. */
export interface ConsoleTarget {
  url: string;
  headers: Record<string, string>;
  tls?: { ca?: string; rejectUnauthorized?: boolean; servername?: string } | undefined;
}

export interface ConsoleOptions {
  register: (path: string) => ConsoleEndpoint;
  tickets: ExecTickets;
  /** Where an open console is recorded, so the resize route can find it. */
  sessions: ConsoleSessions;
  registry: () => InstanceRegistry | undefined;
  log: (message: string) => void;
  /** How many shells may be open at once; injectable for tests. */
  limits?: StreamLimiter;
  /** Opens the socket to Portainer; injectable so tests need no network. */
  connect?: (target: ConsoleTarget, timeoutMs: number) => Promise<RelaySocket> | RelaySocket;
  idleMs?: number;
  /** How long Portainer has to finish the handshake; injectable for tests. */
  connectTimeoutMs?: number;
}

/**
 * How long Portainer has to complete the console handshake.
 *
 * A socket that connects and never upgrades has nothing to time it out: `ws`
 * emits neither 'open' nor 'error', so the await below would stay pending for
 * the life of the process while holding one of the three console permits.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * A shell holds a socket to the browser, a socket to Portainer and a process in
 * a container. Fewer of those than log streams, and for the same reason.
 */
const CONSOLE_LIMITS = { total: 3, perTarget: 2 };

export function openConsole(options: ConsoleOptions): ConsoleServer {
  const endpoint = options.register(CONSOLE_MOUNT);
  const limits = options.limits ?? new StreamLimiter(CONSOLE_LIMITS);
  const open = new Set<() => void>();
  // Accepting is asynchronous — a ticket, then Portainer — and close() can run
  // in the middle of it. Without this, a connection that finished arriving
  // after shutdown would build a relay nothing was left to end.
  const state = { closing: false };

  endpoint.on('error', (error) => options.log(`console endpoint: ${error.message}`));

  endpoint.on('connection', (socket, request) => {
    // accept() contains its own failures, but a throw from outside its try —
    // the listeners it registers first, say — would otherwise be an unhandled
    // rejection, and Node ends the whole Signal K process on one of those.
    void accept(socket, request, options, limits, open, state).catch((cause: unknown) => {
      options.log(
        `console connection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  });

  return {
    close(): void {
      state.closing = true;
      // The endpoint closing terminates the browser sockets; ending each pair
      // first is what closes the sockets to Portainer.
      for (const end of [...open]) end();
      open.clear();
      endpoint.close();
    },
  };
}

async function accept(
  browser: RelaySocket,
  request: { url?: string },
  options: ConsoleOptions,
  limits: StreamLimiter,
  open: Set<() => void>,
  state: { closing: boolean },
): Promise<void> {
  // Registered before anything is awaited: a browser that gives up while
  // Portainer is still answering has already emitted close by the time the
  // await resolves, and a listener added then never runs.
  let gone = false;
  browser.on('close', () => {
    gone = true;
  });
  // Attached here rather than left to relay(): four of the paths below never
  // reach relay, and a `ws` socket that emits 'error' with no listener throws
  // it into the process. signalk-server installs a baseline handler of its
  // own, but the plugin should not depend on the host for that.
  browser.on('error', () => {
    gone = true;
  });
  const grant = options.tickets.consume(ticketOf(request.url));
  if (!grant) {
    // Deliberately uninformative: a caller without a ticket learns only that
    // it needed one.
    browser.close(RELAY_CLOSE.unauthorized, 'no valid console ticket');
    return;
  }

  const registry = options.registry();
  if (!registry) {
    browser.close(RELAY_CLOSE.refused, 'the plugin is not started');
    return;
  }

  let release: (() => void) | undefined;
  // Recorded before anything is awaited. `ws` writes the 101 response before it
  // fires 'connection', so the browser's onopen — and the resize it sends the
  // moment after — arrive while this function is still waiting for the exec
  // socket and the upstream handshake. A session added after those awaits made
  // that first resize a 404, and the shell then stayed at Docker's 80x24 for
  // the rest of its life, which is the failure this session table exists to
  // prevent. Removed again on every path below that does not reach the relay.
  options.sessions.add(grant.session, {
    instance: grant.instance,
    execId: grant.execId,
    containerId: grant.containerId,
  });
  try {
    release = limits.acquire(`${grant.instance ?? registry.defaultName}/${grant.containerId}`);
    const client: PortainerClient = registry.get(grant.instance);
    const target = await client.execSocket(grant.execId);
    const upstream = await (options.connect ?? connectWithWs)(
      target,
      options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );

    // The plugin may have stopped, or the browser given up, while Portainer
    // was answering. Either way there is nothing to relay to, and the socket
    // just opened has to be closed rather than left holding a shell.
    if (state.closing || gone) {
      upstream.close();
      release?.();
      options.sessions.remove(grant.session);
      browser.close(RELAY_CLOSE.refused, 'the console is no longer available');
      return;
    }

    const end = relay(browser, upstream, {
      ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
      onEnd: (reason) => {
        release?.();
        open.delete(end);
        // Before the log line, so nothing can resize a shell that has gone.
        options.sessions.remove(grant.session);
        options.log(`console on ${grant.containerId.slice(0, 12)} ended: ${reason}`);
      },
    });
    open.add(end);
    options.log(`console opened on ${grant.containerId.slice(0, 12)}`);
  } catch (cause) {
    release?.();
    options.sessions.remove(grant.session);
    const refused = cause instanceof StreamLimitError;
    options.log(
      `console on ${grant.containerId.slice(0, 12)} refused: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    browser.close(
      refused ? RELAY_CLOSE.refused : RELAY_CLOSE.upstream,
      refused ? 'too many consoles are open' : 'could not open the shell',
    );
  }
}

/** The ticket from the upgrade URL, which is all this endpoint reads from it. */
export function ticketOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const query = url.slice(url.indexOf('?') + 1);
  const ticket = new URLSearchParams(query).get('ticket');
  return ticket && ticket.length > 0 ? ticket : undefined;
}

/** The real client, kept apart so the relay can be tested without a network. */
async function connectWithWs(target: ConsoleTarget, timeoutMs: number): Promise<RelaySocket> {
  // The same TLS settings the REST calls use. Without these a Portainer behind
  // a private CA answers every request and refuses the console, which is a
  // baffling thing to debug.
  const socket = new WebSocket(target.url, {
    headers: target.headers,
    ...(target.tls?.ca ? { ca: target.tls.ca } : {}),
    ...(target.tls?.servername ? { servername: target.tls.servername } : {}),
    ...(target.tls?.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    // A Portainer that accepts the connection and never completes the upgrade
    // emits neither 'open' nor 'error'. Without this the await never settles,
    // and the console permit it holds is only ever released by an error that
    // will not come: three such sockets and the console is refused until
    // Signal K restarts. `terminate` rather than `close`, because a socket
    // still in the handshake has no close handshake to complete.
    const expiry = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Portainer did not complete the console handshake within ${timeoutMs} ms`));
    }, timeoutMs);
    expiry.unref?.();
    socket.once('open', () => {
      clearTimeout(expiry);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(expiry);
      reject(error);
    });
  });
  return socket as unknown as RelaySocket;
}
