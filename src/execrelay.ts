/**
 * The bridge between the browser's WebSocket and Portainer's.
 *
 * Everything here is about the two sockets ending together. A shell holds a
 * socket to the browser, a socket to Portainer and a process inside a
 * container; whichever end goes first, the other two have to go with it, or a
 * boat server accumulates shells nobody is attached to.
 */

/** The subset of a WebSocket this relay uses, so tests need no network. */
export interface RelaySocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Codes the browser sees, chosen so the panel can say what happened. */
export const RELAY_CLOSE = {
  /** The ticket was missing, expired, or already used. */
  unauthorized: 4401,
  /** The console is not available, or the guards refused it. */
  refused: 4403,
  /** Portainer could not be reached, or dropped the connection. */
  upstream: 4502,
  /** Nothing was typed or printed for the idle timeout. */
  idle: 4408,
} as const;

/**
 * How long a shell may sit with nothing happening.
 *
 * A forgotten shell is worse than a forgotten log stream: it holds a process in
 * the container as well as two sockets. Fifteen minutes is long enough that a
 * pause to read output is not an interruption.
 */
export const DEFAULT_IDLE_MS = 15 * 60_000;

export interface RelayOptions {
  idleMs?: number;
  /** Called once, with the reason, when the pair has finished. */
  onEnd?: (reason: string) => void;
}

/**
 * Joins two sockets until either ends.
 *
 * Returns a function that ends the pair from the outside — the plugin stopping,
 * or a limiter reclaiming the slot.
 */
export function relay(
  browser: RelaySocket,
  upstream: RelaySocket,
  options: RelayOptions = {},
): () => void {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  let ended = false;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const finish = (reason: string, code?: number): void => {
    if (ended) return;
    ended = true;
    if (idle) clearTimeout(idle);
    // Both, always, whichever one reported first.
    safely(() => browser.close(code, reason));
    safely(() => upstream.close());
    options.onEnd?.(reason);
  };

  const touch = (): void => {
    if (ended || idleMs <= 0) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => finish('idle', RELAY_CLOSE.idle), idleMs);
    idle.unref?.();
  };

  browser.on('message', (data) => {
    if (ended) return;
    touch();
    safely(() => upstream.send(asPayload(data)));
  });

  upstream.on('message', (data) => {
    if (ended) return;
    touch();
    safely(() => browser.send(asPayload(data)));
  });

  browser.on('close', () => finish('the browser closed the console'));
  upstream.on('close', () => finish('the shell ended'));
  // An error on either side is a reason to end both, not to log and continue
  // with a half-open pair.
  browser.on('error', () => finish('the browser connection failed'));
  upstream.on('error', () => finish('the connection to Portainer failed', RELAY_CLOSE.upstream));

  touch();
  return () => finish('the plugin stopped');
}

/**
 * What to hand the other socket.
 *
 * Terminal traffic is bytes, and a Buffer or an ArrayBuffer is passed through
 * as it came. Anything else is stringified rather than dropped: a shell that
 * silently swallows a keystroke is worse than one that sends something odd.
 */
function asPayload(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    // ws delivers a fragmented message as an array of buffers.
    const parts = data.filter((part): part is Uint8Array => part instanceof Uint8Array);
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return joined;
  }
  return String(data);
}

/** A send or close on a socket that has already gone is not worth throwing over. */
function safely(action: () => void): void {
  try {
    action();
  } catch {
    // The pair is ending either way.
  }
}
