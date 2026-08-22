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
import type { ExecTickets } from './exectickets';
import type { InstanceRegistry } from './registry';
import { StreamLimiter, StreamLimitError } from './streamlimit';

/** The path the endpoint is registered at, under the plugin's own route. */
export const CONSOLE_PATH = '/console';

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

export interface ConsoleOptions {
  register: (path: string) => ConsoleEndpoint;
  tickets: ExecTickets;
  registry: () => InstanceRegistry | undefined;
  log: (message: string) => void;
  /** How many shells may be open at once; injectable for tests. */
  limits?: StreamLimiter;
  /** Opens the socket to Portainer; injectable so tests need no network. */
  connect?: (target: {
    url: string;
    headers: Record<string, string>;
  }) => Promise<RelaySocket> | RelaySocket;
  idleMs?: number;
}

/**
 * A shell holds a socket to the browser, a socket to Portainer and a process in
 * a container. Fewer of those than log streams, and for the same reason.
 */
const CONSOLE_LIMITS = { total: 3, perTarget: 2 };

export function openConsole(options: ConsoleOptions): ConsoleServer {
  const endpoint = options.register(CONSOLE_PATH);
  const limits = options.limits ?? new StreamLimiter(CONSOLE_LIMITS);
  const open = new Set<() => void>();

  endpoint.on('error', (error) => options.log(`console endpoint: ${error.message}`));

  endpoint.on('connection', (socket, request) => {
    void accept(socket, request, options, limits, open);
  });

  return {
    close(): void {
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
): Promise<void> {
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
  try {
    release = limits.acquire(`${grant.instance ?? registry.defaultName}/${grant.containerId}`);
    const client: PortainerClient = registry.get(grant.instance);
    const target = await client.execSocket(grant.execId);
    const upstream = await (options.connect ?? connectWithWs)(target);

    const end = relay(browser, upstream, {
      ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
      onEnd: (reason) => {
        release?.();
        open.delete(end);
        options.log(`console on ${grant.containerId.slice(0, 12)} ended: ${reason}`);
      },
    });
    open.add(end);
    options.log(`console opened on ${grant.containerId.slice(0, 12)}`);
  } catch (cause) {
    release?.();
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
async function connectWithWs(target: {
  url: string;
  headers: Record<string, string>;
}): Promise<RelaySocket> {
  const socket = new WebSocket(target.url, { headers: target.headers });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (error) => reject(error));
  });
  return socket as unknown as RelaySocket;
}
