import { assignKeys, containerKey, joinPath, normalizeSegment, parseHealth } from '../src/paths';
import type { DockerContainer } from '../src/types';

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer => ({
  Id: 'c1f0e2a3b4c5d6e7f8a9b0c1d2e3f4a5',
  Names: ['/influx'],
  Image: 'influxdb:2.7',
  Created: 0,
  State: 'running',
  Status: 'Up 3 days',
  ...overrides,
});

describe('normalizeSegment', () => {
  it('lowercases and replaces anything a Signal K path cannot carry', () => {
    expect(normalizeSegment('AIS-Logger')).toBe('ais_logger');
    expect(normalizeSegment('signalk.server')).toBe('signalk_server');
    expect(normalizeSegment('  spaced  name ')).toBe('spaced_name');
  });

  it('never returns an empty segment, which would collapse the path', () => {
    // 'a..b' from an empty segment silently reparents everything below it.
    expect(normalizeSegment('---')).toBe('unknown');
    expect(normalizeSegment('')).toBe('unknown');
  });

  it('does not leave leading or trailing underscores', () => {
    expect(normalizeSegment('/influx/')).toBe('influx');
  });
});

describe('containerKey', () => {
  it('prefers compose project and service, which survive a recreate', () => {
    expect(
      containerKey(
        container({
          Labels: {
            'com.docker.compose.project': 'signalk',
            'com.docker.compose.service': 'influxdb',
          },
        }),
      ),
    ).toEqual({ key: 'signalk_influxdb', source: 'compose' });
  });

  it('uses the swarm service name, which already carries its stack', () => {
    expect(
      containerKey(
        container({
          Labels: {
            'com.docker.stack.namespace': 'signalk',
            'com.docker.swarm.service.name': 'signalk_web',
          },
        }),
      ),
    ).toEqual({ key: 'signalk_web', source: 'swarm' });
  });

  it('falls back to the container name', () => {
    expect(containerKey(container({ Names: ['/ais-logger'] }))).toEqual({
      key: 'ais_logger',
      source: 'name',
    });
  });

  it('falls back to the short id when the name is unusable', () => {
    expect(containerKey(container({ Names: ['/---'] }))).toEqual({
      key: 'c1f0e2a3b4c5',
      source: 'id',
    });
    expect(containerKey(container({ Names: [] }))).toEqual({
      key: 'c1f0e2a3b4c5',
      source: 'id',
    });
  });

  it('keeps a container that is genuinely named "unknown" on its name', () => {
    // `unknown` is also what an unusable name normalises to. Treating the two
    // as the same thing sent this container to the short-id fallback, and the
    // short id changes on every recreate — so its path, and every gauge and
    // history behind it, moved each time compose touched it.
    expect(containerKey(container({ Names: ['/unknown'] }))).toEqual({
      key: 'unknown',
      source: 'name',
    });
  });

  it('ignores a label that is present but blank', () => {
    // Compose writes an empty label rather than omitting it in some versions.
    const key = containerKey(
      container({
        Labels: { 'com.docker.compose.project': '  ', 'com.docker.compose.service': 'db' },
      }),
    );
    expect(key.source).toBe('name');
  });
});

describe('assignKeys', () => {
  it('keeps a unique key unqualified', () => {
    const keys = assignKeys([container({ Id: 'aaaa1111bbbb2222', Names: ['/influx'] })]);
    expect(keys.get('aaaa1111bbbb2222')?.key).toBe('influx');
  });

  it('breaks a collision rather than letting one path flicker between two containers', () => {
    // Both normalise to 'ais_logger'; publishing both onto one path would make
    // its value alternate on every poll.
    const keys = assignKeys([
      container({ Id: 'aaaa1111bbbb2222', Names: ['/ais-logger'] }),
      container({ Id: 'cccc3333dddd4444', Names: ['/ais_logger'] }),
    ]);

    const assigned = [keys.get('aaaa1111bbbb2222')?.key, keys.get('cccc3333dddd4444')?.key];
    expect(new Set(assigned).size).toBe(2);
    expect(assigned).toEqual(['ais_logger_aaaa1111bbbb', 'ais_logger_cccc3333dddd']);
  });

  it('assigns the same keys regardless of the order Docker listed them', () => {
    const first = container({ Id: 'aaaa1111bbbb2222', Names: ['/ais-logger'] });
    const second = container({ Id: 'cccc3333dddd4444', Names: ['/ais_logger'] });

    const forward = assignKeys([first, second]);
    const reverse = assignKeys([second, first]);

    expect(forward.get(first.Id)).toEqual(reverse.get(first.Id));
    expect(forward.get(second.Id)).toEqual(reverse.get(second.Id));
  });

  it('does not resolve a collision onto a key another container already holds', () => {
    // The disambiguated key of the first two is exactly what the third one
    // normalises to on its own. Both then publish onto one path, and a PUT
    // reaches whichever of them Docker happened to list last.
    const containers = [
      container({ Id: 'aaaa1111bbbb2222', Names: ['/ais-logger'] }),
      container({ Id: 'cccc3333dddd4444', Names: ['/ais_logger'] }),
      container({ Id: 'eeee5555ffff6666', Names: ['/ais-logger-aaaa1111bbbb'] }),
    ];

    const keys = assignKeys(containers);
    const assigned = containers.map((entry) => keys.get(entry.Id)?.key);

    expect(new Set(assigned).size).toBe(3);
    // The one with the plain name keeps it; the pair widens until it is free.
    expect(assigned[2]).toBe('ais_logger_aaaa1111bbbb');
  });

  it('resolves that collision the same way whatever order Docker listed them in', () => {
    const containers = [
      container({ Id: 'aaaa1111bbbb2222', Names: ['/ais-logger'] }),
      container({ Id: 'cccc3333dddd4444', Names: ['/ais_logger'] }),
      container({ Id: 'eeee5555ffff6666', Names: ['/ais-logger-aaaa1111bbbb'] }),
    ];

    const forward = assignKeys(containers);
    const reverse = assignKeys([...containers].reverse());

    for (const entry of containers) {
      expect(forward.get(entry.Id)).toEqual(reverse.get(entry.Id));
    }
  });
});

describe('parseHealth', () => {
  it.each([
    ['Up 3 days (healthy)', 'healthy'],
    ['Up 2 minutes (unhealthy)', 'unhealthy'],
    ['Up 5 seconds (health: starting)', 'starting'],
  ])('reads %s as %s', (status, expected) => {
    expect(parseHealth(status)).toBe(expected);
  });

  it('reports nothing for a container without a healthcheck', () => {
    // Undefined, not "unknown": the path is then omitted rather than published
    // as a value a dashboard would render.
    expect(parseHealth('Up 3 days')).toBeUndefined();
    expect(parseHealth('Exited (0) 2 hours ago')).toBeUndefined();
    expect(parseHealth(undefined)).toBeUndefined();
  });
});

describe('joinPath', () => {
  it('joins segments and drops empty ones', () => {
    expect(joinPath('system.docker', 'boat', 'status', 'reachable')).toBe(
      'system.docker.boat.status.reachable',
    );
    expect(joinPath('system.docker', '', 'status')).toBe('system.docker.status');
  });
});
