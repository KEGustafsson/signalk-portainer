import type { DockerContainer } from '../../src/types';
import {
  actionLabel,
  actionRequest,
  actionState,
  actionVariant,
  actionsFor,
  isSelfRow,
  needsConfirmation,
  normalizeControl,
  type ControlState,
} from '../../src/webapp/control';

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer =>
  ({
    Id: 'c1f0e2a3b4c5d6e7',
    Names: ['/influx'],
    Image: 'influxdb:2.7',
    State: 'running',
    Status: 'Up 1 hour',
    Created: 0,
    ...overrides,
  }) as DockerContainer;

const control = (overrides: Partial<ControlState> = {}): ControlState => ({
  allowPutControl: true,
  allowDestructive: false,
  allowSelfManagement: false,
  self: {
    inContainer: true,
    identified: true,
    shortId: 'aaaabbbbcccc',
    source: 'cgroup',
    protectionActive: true,
  },
  ...overrides,
});

describe('normalizeControl', () => {
  it('reads a well-formed answer', () => {
    const state = normalizeControl({
      allowPutControl: true,
      allowDestructive: true,
      allowSelfManagement: false,
      self: { inContainer: true, identified: true, shortId: 'abc', source: 'cgroup' },
    });

    expect(state).toMatchObject({ allowPutControl: true, allowDestructive: true });
    expect(state?.self.shortId).toBe('abc');
  });

  it('treats anything missing as not allowed rather than as permission', () => {
    const state = normalizeControl({});

    expect(state).toEqual({
      allowPutControl: false,
      allowDestructive: false,
      allowSelfManagement: false,
      self: {
        inContainer: false,
        identified: false,
        shortId: undefined,
        source: 'none',
        protectionActive: false,
        warning: undefined,
      },
    });
  });

  it('ignores values of the wrong type instead of trusting them', () => {
    // A truthy string is not a permission: only true is.
    const state = normalizeControl({ allowPutControl: 'yes', self: 'nope' });

    expect(state?.allowPutControl).toBe(false);
    expect(state?.self.identified).toBe(false);
  });

  it.each([[null], [undefined], ['a string'], [42]])('rejects %p as a control body', (body) => {
    expect(normalizeControl(body)).toBeUndefined();
  });
});

describe('isSelfRow', () => {
  it('matches the Signal K container by its short id, in either case', () => {
    const state = control({
      self: { ...control().self, shortId: 'c1f0e2a3b4c5' },
    });

    expect(isSelfRow(state, 'c1f0e2a3b4c5d6e7')).toBe(true);
    expect(isSelfRow(state, 'C1F0E2A3B4C5D6E7')).toBe(true);
    expect(isSelfRow(state, 'd2e1f0a9b8c7')).toBe(false);
  });

  it('matches nothing when the plugin could not identify itself', () => {
    expect(isSelfRow(undefined, 'c1f0e2a3b4c5')).toBe(false);
    expect(
      isSelfRow(control({ self: { ...control().self, identified: false } }), 'aaaabbbbcccc'),
    ).toBe(false);
  });
});

describe('actionsFor', () => {
  it('offers only what makes sense for the state', () => {
    expect(actionsFor(container({ State: 'running' }))).toEqual([
      'stop',
      'restart',
      'kill',
      'remove',
    ]);
    expect(actionsFor(container({ State: 'exited' }))).toEqual(['start', 'remove']);
    // A restarting container is on its way up, so it is treated as running.
    expect(actionsFor(container({ State: 'restarting' }))).toContain('stop');
  });
});

describe('actionState', () => {
  it('offers nothing until the plugin has said what is allowed', () => {
    const state = actionState(undefined, container(), 'stop');
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/Waiting for the plugin/);
  });

  it('disables everything when control is off, naming the setting', () => {
    const state = actionState(control({ allowPutControl: false }), container(), 'stop');
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('Allow Signal K PUT control');
  });

  it('disables removal alone when destructive operations are off', () => {
    expect(actionState(control(), container(), 'remove').enabled).toBe(false);
    expect(actionState(control(), container(), 'stop').enabled).toBe(true);
  });

  it('refuses the Signal K container unless self-management is enabled', () => {
    const self = control({ self: { ...control().self, shortId: 'c1f0e2a3b4c5' } });

    expect(actionState(self, container(), 'stop').enabled).toBe(false);
    expect(actionState(self, container(), 'stop').reason).toContain('running Signal K');
    expect(actionState({ ...self, allowSelfManagement: true }, container(), 'stop').enabled).toBe(
      true,
    );
  });
});

describe('actionRequest', () => {
  it('posts lifecycle actions and encodes the id', () => {
    expect(actionRequest('abc/def', 'stop')).toEqual({
      method: 'POST',
      path: '/containers/abc%2Fdef/stop',
    });
  });

  it('sends removal as a DELETE with both options spelled out', () => {
    // Explicit false rather than omitted: the facade's default must not be the
    // only thing standing between a click and a deleted volume.
    expect(actionRequest('abc', 'remove')).toEqual({
      method: 'DELETE',
      path: '/containers/abc?force=false&removeVolumes=false',
    });
    expect(actionRequest('abc', 'remove', { force: true, removeVolumes: true }).path).toBe(
      '/containers/abc?force=true&removeVolumes=true',
    );
  });
});

describe('presentation', () => {
  it('confirms everything except starting', () => {
    expect(needsConfirmation('start')).toBe(false);
    for (const action of ['stop', 'restart', 'kill', 'remove'] as const) {
      expect(needsConfirmation(action)).toBe(true);
    }
  });

  it('does not let a destructive action look routine', () => {
    expect(actionVariant('kill')).toContain('danger');
    expect(actionVariant('remove')).toContain('danger');
    expect(actionVariant('start')).toContain('success');
    expect(actionVariant('restart')).toBe('outline-secondary');
  });

  it('labels each action', () => {
    expect(actionLabel('restart')).toBe('Restart');
  });
});
