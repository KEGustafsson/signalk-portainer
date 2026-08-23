/**
 * TTL cache with in-flight coalescing: concurrent callers asking for the same
 * key share one request, so a busy UI never fans out into duplicate Portainer
 * calls.
 */
export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  /**
   * The load in flight per key, with the epoch it started in.
   *
   * The epoch is carried here because a pending promise is served to later
   * callers before anything else is consulted: a load that started before an
   * invalidation carries pre-invalidation data, so joining a caller that
   * arrived after one to it answers a question it did not ask — stop a
   * container, refetch, and it is still listed as running.
   *
   * invalidate() leaves the entry in place rather than deleting it. Deleting
   * would let the older load's `.finally` remove a newer caller's promise, and
   * every caller after that would start a load of its own.
   */
  private readonly inflight = new Map<string, { promise: Promise<unknown>; epoch: number }>();
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

    const startedAt = this.epoch(key);
    const pending = this.inflight.get(key);
    if (pending && pending.epoch === startedAt) return pending.promise as Promise<T>;

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
        // Only while this load still owns the slot: an invalidation may have
        // let a newer load take it, and that one must outlive this cleanup.
        if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
      });

    this.inflight.set(key, { promise, epoch: startedAt });
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
