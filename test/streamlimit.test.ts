import { StreamLimiter, StreamLimitError } from '../src/streamlimit';

describe('StreamLimiter', () => {
  const limiter = () => new StreamLimiter({ total: 3, perTarget: 2 });

  it('allows streams up to the per-container ceiling', () => {
    const limits = limiter();

    // Two tabs on the same log is ordinary, not abuse.
    expect(() => limits.acquire('boat/influx')).not.toThrow();
    expect(() => limits.acquire('boat/influx')).not.toThrow();
    expect(limits.openCount).toBe(2);
  });

  it('refuses a third stream on the same container', () => {
    const limits = limiter();
    limits.acquire('boat/influx');
    limits.acquire('boat/influx');

    const error = (() => {
      try {
        limits.acquire('boat/influx');
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();

    expect(error).toBeInstanceOf(StreamLimitError);
    expect((error as StreamLimitError).status).toBe(429);
    expect((error as StreamLimitError).message).toContain('for this container');
  });

  it('refuses once the total ceiling is reached, across containers', () => {
    const limits = limiter();
    limits.acquire('boat/a');
    limits.acquire('boat/a');
    limits.acquire('boat/b');

    expect(() => limits.acquire('boat/c')).toThrow(/Too many log streams are open \(3\)/);
  });

  it('counts the same container on two instances separately', () => {
    const limits = limiter();
    limits.acquire('boat/influx');
    limits.acquire('boat/influx');

    // A different Portainer, so a different stream.
    expect(() => limits.acquire('shore/influx')).not.toThrow();
  });

  it('frees the slot when a stream ends', () => {
    const limits = limiter();
    const release = limits.acquire('boat/influx');
    limits.acquire('boat/influx');

    release();

    expect(limits.openCount).toBe(1);
    expect(() => limits.acquire('boat/influx')).not.toThrow();
  });

  it('ignores a second release of the same stream', () => {
    // A stream that fails and is then closed releases twice; without the
    // guard the count drifts down and the ceiling stops meaning anything.
    const limits = limiter();
    const release = limits.acquire('boat/influx');

    release();
    release();
    release();

    expect(limits.openCount).toBe(0);
    limits.acquire('boat/x');
    limits.acquire('boat/y');
    limits.acquire('boat/z');
    expect(() => limits.acquire('boat/w')).toThrow(StreamLimitError);
  });

  it('forgets a container once its last stream closes', () => {
    const limits = limiter();
    const first = limits.acquire('boat/influx');
    const second = limits.acquire('boat/influx');

    first();
    second();

    expect(limits.openCount).toBe(0);
    expect(() => limits.acquire('boat/influx')).not.toThrow();
  });

  it('defaults to ceilings a small boat server can carry', () => {
    const limits = new StreamLimiter();
    for (let index = 0; index < 8; index += 1) limits.acquire(`boat/${index}`);

    expect(limits.openCount).toBe(8);
    expect(() => limits.acquire('boat/one-too-many')).toThrow(StreamLimitError);
  });
});
