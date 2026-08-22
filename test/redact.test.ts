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
});
