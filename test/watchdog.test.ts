import type { InstanceSnapshot } from '../src/deltas';
import type { DockerContainer } from '../src/types';
import { Watchdog } from '../src/watchdog';

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer =>
  ({
    Id: 'c1f0e2a3b4c5d6e7f8a9b0c1d2e3f4a5',
    Names: ['/ais-logger'],
    Image: 'ghcr.io/example/ais-logger:1.4',
    Created: 0,
    State: 'running',
    Status: 'Up 3 days',
    ...overrides,
  }) as DockerContainer;

const up = (containers: DockerContainer[] = [container()]): InstanceSnapshot => ({
  reachable: true,
  containers,
});

const down = (error = 'connect ECONNREFUSED'): InstanceSnapshot => ({
  reachable: false,
  containers: [],
  error,
});

/** Notifications as path → state, which is what the assertions care about. */
const states = (
  notifications: { path: string; value: { state: string } }[],
): Record<string, string> =>
  Object.fromEntries(notifications.map((entry) => [entry.path, entry.value.state]));

describe('Watchdog', () => {
  const watching = () =>
    new Watchdog('system.docker', [{ instance: 'boat', container: 'ais-logger' }]);

  it('says nothing while the watched container is running', () => {
    const watchdog = watching();
    const first = watchdog.evaluate('boat', up());

    // The first poll establishes both states; nothing is in alarm.
    expect(states(first)).toEqual({
      'notifications.system.docker.boat.status': 'normal',
      'notifications.system.docker.boat.containers.ais_logger': 'normal',
    });
  });

  it('raises an alarm when the container is not running', () => {
    const watchdog = watching();
    watchdog.evaluate('boat', up());

    const notifications = watchdog.evaluate(
      'boat',
      up([container({ State: 'exited', Status: 'Exited (1) 2 minutes ago' })]),
    );

    const alarm = notifications.find((entry) => entry.path.endsWith('containers.ais_logger'));
    expect(alarm?.value.state).toBe('alarm');
    expect(alarm?.value.message).toContain('exited');
    // An alarm that does not ask for attention is not an alarm.
    expect(alarm?.value.method).toContain('sound');
  });

  it('clears the alarm when the container comes back', () => {
    const watchdog = watching();
    watchdog.evaluate('boat', up());
    watchdog.evaluate('boat', up([container({ State: 'exited' })]));

    const notifications = watchdog.evaluate('boat', up());

    const cleared = notifications.find((entry) => entry.path.endsWith('containers.ais_logger'));
    expect(cleared?.value.state).toBe('normal');
    expect(cleared?.value.method).toEqual([]);
  });

  it('raises the alarm once, not on every poll', () => {
    const watchdog = watching();
    watchdog.evaluate('boat', up());
    const raised = watchdog.evaluate('boat', up([container({ State: 'exited' })]));
    const again = watchdog.evaluate('boat', up([container({ State: 'exited' })]));

    expect(raised).not.toHaveLength(0);
    // Re-sending an unchanged alarm every 30s is noise; Signal K keeps the
    // last value for clients that connect later.
    expect(again).toHaveLength(0);
  });

  it('alarms when the watched container does not exist at all', () => {
    const watchdog = watching();

    const notifications = watchdog.evaluate(
      'boat',
      up([container({ Names: ['/something-else'] })]),
    );

    const alarm = notifications.find((entry) => entry.path.endsWith('containers.ais_logger'));
    expect(alarm?.value.state).toBe('alarm');
    expect(alarm?.value.message).toContain('does not exist');
  });

  describe('matching a configured watch to a container', () => {
    const matched = (wanted: string, target = container()) =>
      new Watchdog('system.docker', [{ instance: 'boat', container: wanted }])
        .evaluate('boat', up([target]))
        .find((entry) => entry.path.includes('containers.'));

    it('accepts the container name as written', () => {
      expect(matched('ais-logger')?.value.state).toBe('normal');
    });

    it('accepts the normalised path key', () => {
      expect(matched('ais_logger')?.value.state).toBe('normal');
    });

    it('accepts a compose service key', () => {
      const composed = container({
        Names: ['/signalk-influxdb-1'],
        Labels: {
          'com.docker.compose.project': 'signalk',
          'com.docker.compose.service': 'influxdb',
        },
      });
      expect(matched('signalk_influxdb', composed)?.value.state).toBe('normal');
    });

    it('accepts an id prefix', () => {
      expect(matched('c1f0e2a3b4c5')?.value.state).toBe('normal');
    });

    it('does not match a short string against an id by accident', () => {
      // 'c1f' would otherwise match the id prefix and silently watch the wrong
      // container — or the right one for the wrong reason.
      expect(matched('c1f')?.value.state).toBe('alarm');
    });
  });

  describe('when the instance is unreachable', () => {
    it('alarms on the instance and says nothing about its containers', () => {
      const watchdog = watching();
      watchdog.evaluate('boat', up());

      const notifications = watchdog.evaluate('boat', down());

      // A network blip must not turn into a screenful of alarms about
      // containers that are almost certainly running fine.
      expect(states(notifications)).toEqual({
        'notifications.system.docker.boat.status': 'alarm',
      });
    });

    it('carries the reason, so the alarm is actionable', () => {
      const watchdog = watching();
      const [alarm] = watchdog.evaluate('boat', down('certificate has expired'));

      expect(alarm?.value.message).toContain('certificate has expired');
    });

    it('clears the instance alarm when it comes back', () => {
      const watchdog = watching();
      watchdog.evaluate('boat', down());

      const notifications = watchdog.evaluate('boat', up());

      expect(states(notifications)['notifications.system.docker.boat.status']).toBe('normal');
    });
  });

  it('ignores watches configured for another instance', () => {
    const watchdog = new Watchdog('system.docker', [{ instance: 'shore', container: 'backup' }]);

    const notifications = watchdog.evaluate('boat', up());

    expect(Object.keys(states(notifications))).toEqual(['notifications.system.docker.boat.status']);
  });

  it('honours the configured path prefix', () => {
    const watchdog = new Watchdog('electrical.docker', [
      { instance: 'boat', container: 'ais-logger' },
    ]);

    const notifications = watchdog.evaluate('boat', up());

    expect(
      notifications.every((entry) => entry.path.startsWith('notifications.electrical.docker.')),
    ).toBe(true);
  });

  describe('clear', () => {
    it('clears alarms it raised, so a stopped plugin leaves none standing', () => {
      const watchdog = watching();
      watchdog.evaluate('boat', up([container({ State: 'exited' })]));

      const cleared = watchdog.clear();

      expect(cleared.map((entry) => entry.path)).toContain(
        'notifications.system.docker.boat.containers.ais_logger',
      );
      expect(cleared.every((entry) => entry.value.state === 'normal')).toBe(true);
      expect(cleared[0]?.value.message).toContain('no longer checking');
    });

    it('leaves paths alone that were never in alarm', () => {
      const watchdog = watching();
      watchdog.evaluate('boat', up());

      // Everything was normal, so there is nothing to take back.
      expect(watchdog.clear()).toEqual([]);
    });
  });

  it('reports whether anything is being watched', () => {
    expect(new Watchdog('system.docker', []).idle).toBe(true);
    expect(watching().idle).toBe(false);
  });
});
