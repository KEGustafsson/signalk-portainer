import type { DockerDiskUsage } from '../../src/types';
import {
  containerName,
  formatAge,
  formatBytes,
  healthColour,
  imageUsers,
  reclaimableImageBytes,
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

  it('scales a negative size instead of printing it raw', () => {
    // The `< 1000` shortcut used to catch every negative before the loop could
    // scale it, so a Portainer that reported a negative size rendered
    // "-5000000000 B" in the middle of a column of readable ones.
    expect(formatBytes(-5_000_000_000)).toBe('-5.0 GB');
    expect(formatBytes(-999)).toBe('-999 B');
  });

  it('refuses a size that is not a finite number, whatever the type says', () => {
    // The signature says `number | undefined`, but these arrive through an
    // unchecked cast of the Portainer response: a string reaching `.toFixed`
    // throws during render, and the boundary's "Try again" lands right back on
    // the same row. The placeholder is the only honest answer.
    const unchecked = formatBytes as (value: unknown) => string;

    expect(unchecked(null)).toBe('—');
    expect(unchecked('abc')).toBe('—');
    expect(unchecked({})).toBe('—');
    expect(unchecked(Number.POSITIVE_INFINITY)).toBe('—');
    expect(unchecked(Number.NEGATIVE_INFINITY)).toBe('—');
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

describe('healthColour', () => {
  it('keeps "unknown" out of the red badge that means down', () => {
    expect(healthColour('up')).toBe('success');
    expect(healthColour('down')).toBe('danger');
    expect(healthColour('unknown')).toBe('secondary');
  });
});

describe('shortId', () => {
  it('drops the sha256 prefix and truncates', () => {
    expect(shortId('sha256:abcdef0123456789')).toBe('abcdef012345');
    expect(shortId('abcdef0123456789', 4)).toBe('abcd');
    expect(shortId(undefined)).toBe('—');
  });
});

describe('reclaimableImageBytes', () => {
  /**
   * Two images off one base: 100 MB each on their own, 400 MB of base shared
   * between them. Docker reports 600 MB of layers in total.
   */
  const shared: DockerDiskUsage = {
    LayersSize: 600,
    Images: [
      { Id: 'sha256:a', Created: 1, Size: 500, SharedSize: 400, Containers: 1 },
      { Id: 'sha256:b', Created: 1, Size: 500, SharedSize: 400, Containers: 0 },
    ],
  };

  it('does not offer back the base layer the running image still holds', () => {
    // Naively summing the unused image gives 500 — most of which is the base
    // the running one still needs, and none of which a prune would free.
    // Removing the unused image frees its own 100 MB and nothing else.
    expect(reclaimableImageBytes(shared)).toBe(100);
  });

  it('counts everything as reclaimable when no container holds anything', () => {
    expect(
      reclaimableImageBytes({
        LayersSize: 600,
        Images: [{ Id: 'sha256:a', Created: 1, Size: 500, SharedSize: 0, Containers: 0 }],
      }),
    ).toBe(600);
  });

  it('still counts an image whose shared size Docker did not measure', () => {
    // -1 shared is Docker declining to say how much of the 500 MB is common
    // with something else. It does not make the 500 MB reclaimable: a
    // container is holding it either way.
    expect(
      reclaimableImageBytes({
        LayersSize: 600,
        Images: [{ Id: 'sha256:a', Created: 1, Size: 500, SharedSize: -1, Containers: 2 }],
      }),
    ).toBe(100);
  });

  it('leaves an image Docker did not size at all out of the subtraction', () => {
    // Nothing better is available than trusting the total: an unmeasured size
    // cannot be subtracted, so this is the one case that overstates.
    expect(
      reclaimableImageBytes({
        LayersSize: 600,
        Images: [{ Id: 'sha256:a', Created: 1, Size: -1, SharedSize: -1, Containers: 2 }],
      }),
    ).toBe(600);
  });

  it('never reports a negative figure', () => {
    expect(
      reclaimableImageBytes({
        LayersSize: 100,
        Images: [{ Id: 'sha256:a', Created: 1, Size: 500, SharedSize: 0, Containers: 1 }],
      }),
    ).toBe(0);
  });

  it('says nothing at all when Docker has not answered', () => {
    expect(reclaimableImageBytes(undefined)).toBeUndefined();
    expect(reclaimableImageBytes({})).toBeUndefined();
  });
});

describe('imageUsers', () => {
  const usage: DockerDiskUsage = {
    LayersSize: 1,
    Images: [
      { Id: 'sha256:a', Created: 1, Size: 1, Containers: 2 },
      // -1 is Docker declining to count, which is what the image list sends
      // for every row — it must not read as "nothing is using it".
      { Id: 'sha256:b', Created: 1, Size: 1, Containers: -1 },
    ],
  };

  it('reports the count Docker gave', () => {
    expect(imageUsers(usage, 'sha256:a')).toBe(2);
  });

  it('says nothing for an uncounted or unknown image', () => {
    expect(imageUsers(usage, 'sha256:b')).toBeUndefined();
    expect(imageUsers(usage, 'sha256:missing')).toBeUndefined();
    expect(imageUsers(undefined, 'sha256:a')).toBeUndefined();
  });
});
