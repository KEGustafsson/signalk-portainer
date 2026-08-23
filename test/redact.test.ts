import { redactText, redactValue } from '../src/redact';

describe('redactText', () => {
  it('removes Portainer API tokens', () => {
    expect(redactText('using ptr_AbC123-_= now')).toBe('using [redacted] now');
  });

  it('removes JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.sIgNaTuRe';
    expect(redactText(`Bearer ${jwt}`)).toBe('Bearer [redacted]');
  });

  it('leaves ordinary text alone', () => {
    expect(redactText('container ais-logger exited')).toBe('container ais-logger exited');
  });
});

describe('redactValue', () => {
  it('masks secret-looking keys at any depth', () => {
    const input = {
      name: 'local',
      auth: { apiKey: 'ptr_secret', username: 'admin', password: 'hunter2' },
      nested: [{ token: 'abc' }],
    };
    expect(redactValue(input)).toEqual({
      name: 'local',
      auth: { apiKey: '[redacted]', username: 'admin', password: '[redacted]' },
      nested: [{ token: '[redacted]' }],
    });
  });

  it('keeps empty and absent secrets distinguishable from set ones', () => {
    expect(redactValue({ apiKey: '', password: null })).toEqual({ apiKey: '', password: null });
  });

  it('still scrubs credentials that appear inside ordinary string values', () => {
    expect(redactValue({ error: 'rejected ptr_abc123' })).toEqual({ error: 'rejected [redacted]' });
  });

  it('matches secret keys regardless of separators or casing', () => {
    expect(
      redactValue({
        api_key: 'a',
        'api-key': 'b',
        'X-API-Key': 'c',
        accessToken: 'd',
        refresh_token: 'e',
        Cookie: 'f',
        secret: 'g',
      }),
    ).toEqual({
      api_key: '[redacted]',
      'api-key': '[redacted]',
      'X-API-Key': '[redacted]',
      accessToken: '[redacted]',
      refresh_token: '[redacted]',
      Cookie: '[redacted]',
      secret: '[redacted]',
    });
  });

  it('leaves a CA certificate readable — it is public material', () => {
    expect(redactValue({ ca: 'PEM', servername: 'boatpi' })).toEqual({
      ca: 'PEM',
      servername: 'boatpi',
    });
  });

  it('preserves non-plain objects instead of reducing them to {}', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const error = new Error('boom');
    const buffer = Buffer.from('hi');
    const result = redactValue({ date, error, buffer, set: new Set([1]) });

    expect(result.date).toBe(date);
    expect(result.error).toBe(error);
    expect(result.buffer).toBe(buffer);
    expect(result.set).toBeInstanceOf(Set);
  });

  it('breaks cycles instead of recursing forever', () => {
    const node: Record<string, unknown> = { name: 'local' };
    node.self = node;

    expect(() => redactValue(node)).not.toThrow();
    expect((redactValue(node) as { self: unknown }).self).toBe('[circular]');
  });

  it('keeps one object referenced twice, which is not a cycle', () => {
    // Every facade response goes through here. A shared object — one container
    // listed under two keys, one environment on two instances — is repetition,
    // not recursion, and blanking the second sighting deletes real data from
    // the response the panel renders.
    const shared = { name: 'influxdb', state: 'running' };

    expect(redactValue({ a: shared, b: shared })).toEqual({
      a: { name: 'influxdb', state: 'running' },
      b: { name: 'influxdb', state: 'running' },
    });
  });

  it('keeps a row that appears twice in the same list', () => {
    const row = { id: 'abc' };

    expect(redactValue({ list: [row, row] })).toEqual({ list: [{ id: 'abc' }, { id: 'abc' }] });
  });

  it('still catches a cycle reached through a sibling branch', () => {
    // The narrower guard must not lose the case it exists for: the root is
    // reachable again from inside one of its own children.
    const root: Record<string, unknown> = { name: 'local' };
    root.children = [{ parent: root }];

    const result = redactValue(root) as { children: { parent: unknown }[] };
    expect(result.children[0]?.parent).toBe('[circular]');
  });
});
