/**
 * TTL cache with in-flight coalescing: concurrent callers asking for the same
 * key share one request, so a busy UI never fans out into duplicate Portainer
 * calls.
 */
export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /**
   * Per-key epoch, bumped by invalidate(); a load started in an earlier epoch
   * never writes. Kept per key rather than global so invalidating the container
   * list does not discard an environment lookup that happens to be in flight.
   */
  private readonly epochs = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry.value as T;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const startedAt = this.epoch(key);
    const promise = load()
      .then((value) => {
        // A load that was already in flight when invalidate() ran carries data
        // from before the invalidation and must not repopulate the cache.
        if (startedAt === this.epoch(key)) {
          this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
        }
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Drops one key, several keys, or — with no argument — everything. */
  invalidate(key?: string | readonly string[]): void {
    const keys =
      key === undefined
        ? new Set([...this.entries.keys(), ...this.inflight.keys()])
        : typeof key === 'string'
          ? [key]
          : key;
    for (const name of keys) {
      this.epochs.set(name, this.epoch(name) + 1);
      this.entries.delete(name);
    }
  }

  private epoch(key: string): number {
    return this.epochs.get(key) ?? 0;
  }
}

export const TTL = {
  environments: 60_000,
  dockerInfo: 300_000,
  stacks: 15_000,
  containers: 5_000,
} as const;
