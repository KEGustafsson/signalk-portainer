import { TtlCache } from '../src/cache';

describe('TtlCache', () => {
  it('serves a cached value until it expires', async () => {
    let now = 1000;
    const cache = new TtlCache(() => now);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return loads;
    };

    await expect(cache.get('k', 100, load)).resolves.toBe(1);
    await expect(cache.get('k', 100, load)).resolves.toBe(1);
    now += 101;
    await expect(cache.get('k', 100, load)).resolves.toBe(2);
  });

  it('shares one load between concurrent callers', async () => {
    const cache = new TtlCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return 'value';
    };

    await Promise.all([cache.get('k', 100, load), cache.get('k', 100, load)]);
    expect(loads).toBe(1);
  });

  it('does not let a load that started before invalidate() repopulate the cache', async () => {
    const cache = new TtlCache();
    let release: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });

    const inflight = cache.get('k', 10_000, () => slow);
    cache.invalidate();
    release('stale');
    await inflight;

    // Without the epoch guard this resolves to the pre-invalidation value.
    await expect(cache.get('k', 10_000, async () => 'fresh')).resolves.toBe('fresh');
  });

  it('does not join a caller that arrived after invalidate() to the load in flight', async () => {
    const cache = new TtlCache();
    let release: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });

    const inflight = cache.get('containers:false', 10_000, () => slow);
    // Stop a container: the list in flight was read before the stop and says
    // it is running. Serving it to the refetch that follows shows the operator
    // a container that is still running after they stopped it.
    cache.invalidate(['containers:false']);
    const afterwards = cache.get('containers:false', 10_000, async () => 'fresh');
    release('stale');

    await expect(inflight).resolves.toBe('stale');
    await expect(afterwards).resolves.toBe('fresh');
  });

  it('still coalesces the callers that arrive after an invalidation', async () => {
    const cache = new TtlCache();
    let release: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });
    let loads = 0;

    const inflight = cache.get('k', 10_000, () => slow);
    cache.invalidate('k');
    let releaseFresh: (value: string) => void = () => {};
    const fresh = new Promise<string>((resolve) => {
      releaseFresh = resolve;
    });
    const load = () => {
      loads += 1;
      return fresh;
    };
    const [a, b] = [cache.get('k', 10_000, load), cache.get('k', 10_000, load)];
    // The superseded load finishing must not take the newer one's slot with it.
    release('stale');
    await inflight;

    // Held open on purpose: a caller arriving now proves the replacement is
    // still in flight and still joinable. If the stale load's cleanup had
    // deleted it, this would start a third load instead.
    const c = cache.get('k', 10_000, load);
    releaseFresh('fresh');

    await expect(Promise.all([a, b, c])).resolves.toEqual(['fresh', 'fresh', 'fresh']);
    expect(loads).toBe(1);
  });

  it('drops only the keys it was given', async () => {
    const cache = new TtlCache();
    await cache.get('a', 10_000, async () => 'a1');
    await cache.get('b', 10_000, async () => 'b1');
    await cache.get('c', 10_000, async () => 'c1');

    cache.invalidate(['a', 'c']);

    await expect(cache.get('a', 10_000, async () => 'a2')).resolves.toBe('a2');
    await expect(cache.get('b', 10_000, async () => 'b2')).resolves.toBe('b1');
    await expect(cache.get('c', 10_000, async () => 'c2')).resolves.toBe('c2');
  });

  it('leaves an unrelated in-flight load free to populate the cache', async () => {
    const cache = new TtlCache();
    let release: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });

    // The environment lookup is in flight when a container mutation drops the
    // container list. A shared epoch would discard this result too, costing a
    // fresh GET /api/endpoints for no reason.
    const inflight = cache.get('environment', 10_000, () => slow);
    cache.invalidate(['containers:false']);
    release('env');
    await inflight;

    await expect(cache.get('environment', 10_000, async () => 'reloaded')).resolves.toBe('env');
  });
});
