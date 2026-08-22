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
});
