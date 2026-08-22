import {
  containerName,
  formatAge,
  formatBytes,
  shortId,
  stateColour,
} from '../../src/webapp/format';

describe('formatBytes', () => {
  it('scales through units and keeps small numbers readable', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 kB');
    expect(formatBytes(412_000_000)).toBe('412 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
  });

  it('does not run off the end of the unit table', () => {
    expect(formatBytes(9_000_000_000_000_000)).toContain('TB');
  });

  it('renders an absent size as a dash rather than NaN', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatAge', () => {
  const now = Date.UTC(2026, 0, 2, 0, 0, 0);
  const secondsAgo = (seconds: number) => now / 1000 - seconds;

  it('picks a sensible unit', () => {
    expect(formatAge(secondsAgo(30), now)).toBe('30s');
    expect(formatAge(secondsAgo(120), now)).toBe('2m');
    expect(formatAge(secondsAgo(7200), now)).toBe('2h');
    expect(formatAge(secondsAgo(259_200), now)).toBe('3d');
  });

  it('never shows a negative age when clocks disagree', () => {
    expect(formatAge(secondsAgo(-500), now)).toBe('0s');
  });

  it('renders a missing timestamp as a dash', () => {
    expect(formatAge(undefined, now)).toBe('—');
    expect(formatAge(0, now)).toBe('—');
  });
});

describe('containerName', () => {
  it('strips the leading slash Docker adds', () => {
    expect(containerName(['/signalk_influxdb'])).toBe('signalk_influxdb');
  });

  it('handles a name without a slash, and no name at all', () => {
    expect(containerName(['plain'])).toBe('plain');
    expect(containerName([])).toBe('—');
    expect(containerName(undefined)).toBe('—');
  });
});

describe('stateColour', () => {
  it('maps Docker states onto badge colours', () => {
    expect(stateColour('running')).toBe('success');
    expect(stateColour('restarting')).toBe('warning');
    expect(stateColour('exited')).toBe('danger');
    expect(stateColour('dead')).toBe('danger');
    expect(stateColour('paused')).toBe('secondary');
  });
});

describe('shortId', () => {
  it('drops the sha256 prefix and truncates', () => {
    expect(shortId('sha256:abcdef0123456789')).toBe('abcdef012345');
    expect(shortId('abcdef0123456789', 4)).toBe('abcd');
    expect(shortId(undefined)).toBe('—');
  });
});
