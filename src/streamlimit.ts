/**
 * Caps on how many log streams can be open at once.
 *
 * Each follow stream holds a connection to Portainer and a socket to the
 * browser for as long as someone leaves the tab open. Without a ceiling, a
 * handful of forgotten tabs on a Raspberry Pi is enough to exhaust the file
 * descriptors that Signal K itself needs.
 */

export interface StreamLimits {
  /** Across every container and instance. */
  total: number;
  /** For one container — several tabs on the same log is ordinary. */
  perTarget: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = { total: 8, perTarget: 3 };

export class StreamLimitError extends Error {
  readonly status = 429;
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'StreamLimitError';
    this.hint = hint;
  }
}

/**
 * Hands out permits for open streams. Every acquire that succeeds returns the
 * release that must be called when the stream ends — including when it ends by
 * failing, which is why callers put it in a finally.
 */
export class StreamLimiter {
  private readonly open = new Map<string, number>();
  private total = 0;

  constructor(private readonly limits: StreamLimits = DEFAULT_STREAM_LIMITS) {}

  get openCount(): number {
    return this.total;
  }

  /** @throws StreamLimitError when either ceiling is already reached. */
  acquire(target: string): () => void {
    if (this.total >= this.limits.total) {
      throw new StreamLimitError(
        `Too many log streams are open (${this.limits.total})`,
        'close a log view elsewhere, or wait for one to end',
      );
    }
    const current = this.open.get(target) ?? 0;
    if (current >= this.limits.perTarget) {
      throw new StreamLimitError(
        `Too many log streams are open for this container (${this.limits.perTarget})`,
        'close one of the views already following this container',
      );
    }

    this.open.set(target, current + 1);
    this.total += 1;

    let released = false;
    return () => {
      // Guarded: a double release would let the count drift downward and
      // eventually allow unlimited streams.
      if (released) return;
      released = true;
      this.total -= 1;
      const remaining = (this.open.get(target) ?? 1) - 1;
      if (remaining <= 0) this.open.delete(target);
      else this.open.set(target, remaining);
    };
  }
}
