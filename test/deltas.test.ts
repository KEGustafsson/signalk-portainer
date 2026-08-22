import { DeltaBuilder, type InstanceSnapshot } from '../src/deltas';
import type { DockerContainer } from '../src/types';

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer =>
  ({
    Id: 'c1f0e2a3b4c5d6e7f8a9b0c1d2e3f4a5',
    Names: ['/influx'],
    Image: 'influxdb:2.7',
    Created: 0,
    State: 'running',
    Status: 'Up 3 days (healthy)',
    ...overrides,
  }) as DockerContainer;

const snapshot = (overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot => ({
  reachable: true,
  containers: [container()],
  ...overrides,
});

/** The values as a plain path → value map, which is what assertions want. */
const byPath = (values: { path: string; value: unknown }[]): Record<string, unknown> =>
  Object.fromEntries(values.map((entry) => [entry.path, entry.value]));

describe('DeltaBuilder', () => {
  it('publishes instance status and a container under its compose key', () => {
    const builder = new DeltaBuilder('system.docker', 'boat');

    const { values } = builder.build(
      snapshot({
        version: '24.0.7',
        containers: [
          container({
            Labels: {
              'com.docker.compose.project': 'signalk',
              'com.docker.compose.service': 'influxdb',
            },
          }),
        ],
      }),
    );

    expect(byPath(values)).toMatchObject({
      'system.docker.boat.status.reachable': true,
      'system.docker.boat.status.version': '24.0.7',
      'system.docker.boat.status.containersRunning': 1,
      'system.docker.boat.status.containersTotal': 1,
      'system.docker.boat.containers.signalk_influxdb.state': 'running',
      'system.docker.boat.containers.signalk_influxdb.health': 'healthy',
      'system.docker.boat.containers.signalk_influxdb.image': 'influxdb:2.7',
      'system.docker.boat.containers.signalk_influxdb.name': 'influx',
      'system.docker.boat.containers.signalk_influxdb.id': 'c1f0e2a3b4c5',
    });
  });

  it('honours the configured path prefix', () => {
    const builder = new DeltaBuilder('electrical.docker', 'boat');
    const { values } = builder.build(snapshot());

    expect(values.every((entry) => entry.path.startsWith('electrical.docker.boat.'))).toBe(true);
  });

  it('counts only running containers as running', () => {
    const builder = new DeltaBuilder('system.docker', 'boat');
    const { values } = builder.build(
      snapshot({
        containers: [
          container({ Id: 'a'.repeat(32), Names: ['/up'] }),
          container({ Id: 'b'.repeat(32), Names: ['/down'], State: 'exited' }),
        ],
      }),
    );

    expect(byPath(values)['system.docker.boat.status.containersRunning']).toBe(1);
    expect(byPath(values)['system.docker.boat.status.containersTotal']).toBe(2);
  });

  it('omits health for a container that has no healthcheck', () => {
    const builder = new DeltaBuilder('system.docker', 'boat');
    const { values } = builder.build(
      snapshot({ containers: [container({ Status: 'Up 3 days' })] }),
    );

    // Absent, not null: null would render as a value in a dashboard.
    expect(Object.keys(byPath(values))).not.toContain(
      'system.docker.boat.containers.influx.health',
    );
  });

  describe('levels', () => {
    it('publishes only state and health at the health level', () => {
      const builder = new DeltaBuilder('system.docker', 'boat', 'health');
      const paths = Object.keys(byPath(builder.build(snapshot()).values));

      expect(paths).toContain('system.docker.boat.containers.influx.state');
      expect(paths).toContain('system.docker.boat.containers.influx.health');
      expect(paths).not.toContain('system.docker.boat.containers.influx.image');
      expect(paths).not.toContain('system.docker.boat.containers.influx.name');
      expect(paths).not.toContain('system.docker.boat.containers.influx.id');
      // The instance status is the point of the health level, so it stays.
      expect(paths).toContain('system.docker.boat.status.containersRunning');
    });

    it('adds the identifying strings at the full level', () => {
      const builder = new DeltaBuilder('system.docker', 'boat', 'full');
      const paths = Object.keys(byPath(builder.build(snapshot()).values));

      expect(paths).toContain('system.docker.boat.containers.influx.image');
      expect(paths).toContain('system.docker.boat.containers.influx.id');
    });
  });

  describe('metadata', () => {
    it('describes a path the first time it is published, and not again', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');

      const first = builder.build(snapshot());
      const second = builder.build(snapshot());

      const described = first.meta.map((entry) => entry.path);
      expect(described).toContain('system.docker.boat.status.reachable');
      expect(described).toContain('system.docker.boat.containers.influx.state');
      // Meta is per-path and permanent; repeating it every poll is noise.
      expect(second.meta).toHaveLength(0);
    });

    it('describes a container that appears later', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot());

      const { meta } = builder.build(
        snapshot({
          containers: [container(), container({ Id: 'b'.repeat(32), Names: ['/new'] })],
        }),
      );

      expect(meta.map((entry) => entry.path)).toContain('system.docker.boat.containers.new.state');
    });
  });

  describe('when an instance is unreachable', () => {
    it('says so and claims nothing about its containers', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      const { values } = builder.build({ reachable: false, containers: [], error: 'timeout' });

      expect(byPath(values)).toEqual({ 'system.docker.boat.status.reachable': false });
      // Not zero containers: a failed poll knows nothing about the environment,
      // and "0 running" would read as every container being down.
      expect(Object.keys(byPath(values))).not.toContain(
        'system.docker.boat.status.containersRunning',
      );
    });

    it('leaves the last known container values in place rather than clearing them', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot());

      const { values } = builder.build({ reachable: false, containers: [] });

      expect(values.some((entry) => entry.path.includes('containers.influx'))).toBe(false);
    });
  });

  describe('when a value stops being reported', () => {
    it('clears health when a container is recreated without a healthcheck', () => {
      // Same compose service, same key, but the new container has no
      // healthcheck. Without clearing, the old verdict — possibly "unhealthy" —
      // sits in the data model forever.
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot());

      const { values } = builder.build(
        snapshot({ containers: [container({ Status: 'Up 2 seconds' })] }),
      );

      expect(byPath(values)['system.docker.boat.containers.influx.health']).toBeNull();
      // The container is still there, so its other paths carry values.
      expect(byPath(values)['system.docker.boat.containers.influx.state']).toBe('running');
    });

    it('clears it once, not on every later poll', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot());
      builder.build(snapshot({ containers: [container({ Status: 'Up 2 seconds' })] }));

      const { values } = builder.build(
        snapshot({ containers: [container({ Status: 'Up 3 seconds' })] }),
      );

      expect(Object.keys(byPath(values))).not.toContain(
        'system.docker.boat.containers.influx.health',
      );
    });
  });

  describe('when a container disappears', () => {
    it('clears its paths once and then stops mentioning it', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot());

      const cleared = byPath(builder.build(snapshot({ containers: [] })).values);
      expect(cleared['system.docker.boat.containers.influx.state']).toBeNull();
      expect(cleared['system.docker.boat.containers.influx.image']).toBeNull();

      const after = byPath(builder.build(snapshot({ containers: [] })).values);
      expect(Object.keys(after)).not.toContain('system.docker.boat.containers.influx.state');
    });

    it('clears exactly the suffixes it published, and no others', () => {
      // Publishing null to a path that was never published creates it: the
      // dashboard grows a permanently empty row instead of staying clean.
      const builder = new DeltaBuilder('system.docker', 'boat', 'health');
      builder.build(snapshot());

      const cleared = byPath(builder.build(snapshot({ containers: [] })).values);

      expect(cleared['system.docker.boat.containers.influx.state']).toBeNull();
      expect(cleared['system.docker.boat.containers.influx.health']).toBeNull();
      expect(Object.keys(cleared)).not.toContain('system.docker.boat.containers.influx.image');
    });

    it('clears only what a container without a healthcheck ever published', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot({ containers: [container({ Status: 'Up 3 days' })] }));

      const cleared = byPath(builder.build(snapshot({ containers: [] })).values);

      expect(cleared['system.docker.boat.containers.influx.state']).toBeNull();
      expect(Object.keys(cleared)).not.toContain('system.docker.boat.containers.influx.health');
    });
  });

  describe('clear', () => {
    it('nulls everything it published, so a stopped plugin leaves no stale state', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot());

      const cleared = byPath(builder.clear());

      expect(cleared['system.docker.boat.containers.influx.state']).toBeNull();
      expect(cleared['system.docker.boat.status.reachable']).toBeNull();
    });

    it('clears the instance status paths too, not just the containers', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot({ version: '24.0.7' }));

      const cleared = byPath(builder.clear());

      // A stopped plugin leaving a container count behind has a dashboard
      // reporting containers nobody is watching any more.
      expect(cleared['system.docker.boat.status.reachable']).toBeNull();
      expect(cleared['system.docker.boat.status.version']).toBeNull();
      expect(cleared['system.docker.boat.status.containersRunning']).toBeNull();
      expect(cleared['system.docker.boat.status.containersTotal']).toBeNull();
    });

    it('does not clear a status path that was never published', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      // Never reachable, so the counts and version were never published.
      builder.build({ reachable: false, containers: [] });

      const cleared = byPath(builder.clear());

      expect(cleared['system.docker.boat.status.reachable']).toBeNull();
      expect(Object.keys(cleared)).not.toContain('system.docker.boat.status.version');
      expect(Object.keys(cleared)).not.toContain('system.docker.boat.status.containersTotal');
    });

    it('is idempotent', () => {
      const builder = new DeltaBuilder('system.docker', 'boat');
      builder.build(snapshot());
      builder.clear();

      expect(builder.clear()).toEqual([]);
    });
  });
});
