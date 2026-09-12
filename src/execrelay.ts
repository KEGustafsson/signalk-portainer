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
  on(event: 'close', listener: (code?: number, reason?: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
  /** Withdraws a listener, so a handler can hand its work to another. */
  off?(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  /** Bytes queued for the peer, which `ws` reports and a test can fake. */
  readonly bufferedAmount?: number;
  /**
   * Backpressure and liveness, as `ws` provides them. Optional so a test
   * double — and the browser socket a Signal K server hands over, which is a
   * `ws` socket but typed as less — need not implement what it does not use;
   * every call site checks before calling.
   */
  pause?(): void;
  resume?(): void;
  ping?(data?: unknown): void;
  terminate?(): void;
}

/** Codes the browser sees, chosen so the panel can say what happened. */
export const RELAY_CLOSE = {
  /** An ordinary end — the shell exited, or the plugin stopped. */
  normal: 1000,
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

/**
 * How often each socket is pinged, and how long a silent peer has to answer.
 *
 * A browser that vanished without a FIN — a laptop that slept, a WiFi link
 * that dropped — otherwise holds its shell, its process in the container and
 * one of the three console permits until the idle timer fires, and a NAT
 * between the plugin and Portainer commonly forgets an idle connection long
 * before that.
 */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * How much may be queued for a peer before the other side is told to stop
 * reading, and the level it has to fall back to before it resumes.
 *
 * A shell running `yes` on a LAN-speed Portainer, relayed to a phone on a
 * weak link, is the whole difference between the two rates piling up in the
 * Node heap — which on a Raspberry Pi is what OOM-kills Signal K.
 */
const BACKPRESSURE_HIGH_BYTES = 1024 * 1024;
const BACKPRESSURE_LOW_BYTES = 256 * 1024;
/** Past this much queued, the peer is not keeping up at all and the pair ends. */
const BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;
/** How often the queue is looked at while a side is paused. */
const BACKPRESSURE_POLL_MS = 100;

/**
 * The largest single message that will be relayed. Terminal traffic is
 * keystrokes and screenfuls; anything at this scale is a paste of a file,
 * which the shell would not read as a command anyway.
 */
const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface RelayOptions {
  idleMs?: number;
  /** 0 turns the heartbeat off, for tests that drive the sockets by hand. */
  heartbeatMs?: number;
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
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let ended = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let drain: ReturnType<typeof setInterval> | undefined;

  const finish = (reason: string, code?: number): void => {
    if (ended) return;
    ended = true;
    if (idle) clearTimeout(idle);
    if (heartbeat) clearInterval(heartbeat);
    if (drain) clearInterval(drain);
    // Both, always, whichever one reported first. The code is always sent:
    // `ws` drops the reason when the code is undefined, so the peer saw a bare
    // 1005 and the panel's handling of the reason never ran.
    safely(() => browser.close(code ?? RELAY_CLOSE.normal, reason));
    safely(() => upstream.close());
    options.onEnd?.(reason);
  };

  /**
   * Forwards one message, and holds the sender back when the receiver cannot
   * keep up.
   *
   * `bufferedAmount` is what `ws` has queued for a peer it cannot write to
   * fast enough. Left unread — which is how this started — the queue is the
   * only thing bounding a fast shell writing to a slow browser, and it is
   * bounded by the heap.
   */
  const forward = (from: RelaySocket, to: RelaySocket, data: unknown): void => {
    const payload = asPayload(data);
    if (payload.length > MAX_MESSAGE_BYTES) {
      finish('a message was too large to relay', RELAY_CLOSE.refused);
      return;
    }
    safely(() => to.send(payload));

    const queued = to.bufferedAmount ?? 0;
    if (queued > BACKPRESSURE_LIMIT_BYTES) {
      finish('the other end could not keep up', RELAY_CLOSE.refused);
      return;
    }
    if (drain || queued <= BACKPRESSURE_HIGH_BYTES || !can(from, 'pause')) return;

    invoke(from, 'pause');
    drain = setInterval(() => {
      if (ended) return;
      const left = to.bufferedAmount ?? 0;
      if (left > BACKPRESSURE_LIMIT_BYTES) {
        finish('the other end could not keep up', RELAY_CLOSE.refused);
        return;
      }
      if (left > BACKPRESSURE_LOW_BYTES) return;
      if (drain) clearInterval(drain);
      drain = undefined;
      invoke(from, 'resume');
    }, BACKPRESSURE_POLL_MS);
    drain.unref?.();
  };

  /**
   * Restarts the idle countdown. Called for what the operator types and for
   * nothing else.
   *
   * Output used to count as use, and there is no ping/pong on this path, so a
   * shell printing continuously — `tail -f`, a build log — to a browser that
   * vanished without a FIN was never idle: it held a process in the container
   * and an outbound buffer that only grew. The cost is that a shell watched
   * silently for fifteen minutes ends; the alternative is one that never does.
   */
  const touch = (): void => {
    if (ended || idleMs <= 0) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => finish('idle', RELAY_CLOSE.idle), idleMs);
    idle.unref?.();
  };

  browser.on('message', (data) => {
    if (ended) return;
    touch();
    forward(browser, upstream, data);
  });

  upstream.on('message', (data) => {
    if (ended) return;
    forward(upstream, browser, data);
  });

  browser.on('close', () => finish('the browser closed the console'));
  // Portainer closing for its own reasons — the agent lost, Docker restarted,
  // the proxy giving up — is not the shell exiting, and saying it was sends
  // the operator to open another one that fails the same way.
  upstream.on('close', (code) => {
    const clean = code === undefined || code === 1000 || code === 1005;
    if (clean) finish('the shell ended');
    else finish(`the connection to Portainer closed (${code})`, RELAY_CLOSE.upstream);
  });
  // An error on either side is a reason to end both, not to log and continue
  // with a half-open pair.
  browser.on('error', () => finish('the browser connection failed'));
  upstream.on('error', () => finish('the connection to Portainer failed', RELAY_CLOSE.upstream));

  // Liveness, both ways. A peer that answers nothing for two rounds is gone
  // whatever its socket still says, and terminate() is what reclaims a
  // half-open TCP connection that close() would wait forever to shut down.
  if (heartbeatMs > 0 && can(browser, 'ping')) {
    const alive = new WeakSet<RelaySocket>([browser, upstream]);
    for (const socket of [browser, upstream]) {
      socket.on('pong', () => alive.add(socket));
    }
    heartbeat = setInterval(() => {
      if (ended) return;
      for (const socket of [browser, upstream]) {
        if (!can(socket, 'ping')) continue;
        if (!alive.has(socket)) {
          invoke(socket, 'terminate');
          finish('the connection stopped answering', RELAY_CLOSE.upstream);
          return;
        }
        alive.delete(socket);
        invoke(socket, 'ping');
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

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

/** Whether a socket offers one of the optional `ws` methods at all. */
function can(socket: RelaySocket, name: 'pause' | 'resume' | 'ping' | 'terminate'): boolean {
  return typeof socket[name] === 'function';
}

/**
 * Calls one of those methods on the socket itself, so it keeps its `this`,
 * and swallows what a socket in the middle of closing throws.
 */
function invoke(socket: RelaySocket, name: 'pause' | 'resume' | 'ping' | 'terminate'): void {
  if (!can(socket, name)) return;
  safely(() => {
    socket[name]?.();
  });
}

/** A send or close on a socket that has already gone is not worth throwing over. */
function safely(action: () => void): void {
  try {
    action();
  } catch {
    // The pair is ending either way.
  }
}
