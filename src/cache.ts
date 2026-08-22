/**
 * TTL cache with in-flight coalescing: concurrent callers asking for the same
 * key share one request, so a busy UI never fans out into duplicate Portainer
 * calls.
 */
export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Bumped by invalidate(); loads started in an earlier epoch never write. */
  private epoch = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry.value as T;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const startedAt = this.epoch;
    const promise = load()
      .then((value) => {
        // A load that was already in flight when invalidate() ran carries data
        // from before the invalidation and must not repopulate the cache.
        if (startedAt === this.epoch) {
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

  invalidate(key?: string): void {
    this.epoch += 1;
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}

export const TTL = {
  environments: 60_000,
  dockerInfo: 300_000,
  stacks: 15_000,
  containers: 5_000,
} as const;
