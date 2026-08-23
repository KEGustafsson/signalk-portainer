import type { DockerContainer } from '../../src/types';
import {
  actionLabel,
  actionRequest,
  actionState,
  actionVariant,
  actionsFor,
  imageActionLabel,
  imageActionState,
  imageRequest,
  isSelfRow,
  needsConfirmation,
  normalizeControl,
  requiresForceToRemove,
  type ControlState,
} from '../../src/webapp/control';

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer => ({
  Id: 'c1f0e2a3b4c5d6e7',
  Names: ['/influx'],
  Image: 'influxdb:2.7',
  State: 'running',
  Status: 'Up 1 hour',
  Created: 0,
  ...overrides,
});

const control = (overrides: Partial<ControlState> = {}): ControlState => ({
  allowPutControl: true,
  allowDestructive: false,
  allowSelfManagement: false,
  console: { available: true },
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
      console: { available: false },
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

  it('reads what the server said about the console', () => {
    const state = normalizeControl({
      console: { available: false, reason: 'this Signal K server cannot serve a plugin WebSocket' },
    });

    expect(state?.console).toEqual({
      available: false,
      reason: 'this Signal K server cannot serve a plugin WebSocket',
    });
  });

  it('reads a console the server can serve', () => {
    expect(normalizeControl({ console: { available: true } })?.console).toEqual({
      available: true,
    });
  });

  it('takes a missing or misshapen console field as no console', () => {
    // The safe direction, and the one an older plugin build produces.
    expect(normalizeControl({})?.console).toEqual({ available: false });
    expect(normalizeControl({ console: 'yes' })?.console).toEqual({ available: false });
    expect(normalizeControl({ console: { available: 'yes' } })?.console).toEqual({
      available: false,
    });
    expect(normalizeControl({ console: { available: false, reason: 7 } })?.console).toEqual({
      available: false,
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
      'pause',
      'kill',
      'remove',
    ]);
    expect(actionsFor(container({ State: 'exited' }))).toEqual(['start', 'remove']);
    // A restarting container is on its way up, so it is treated as running.
    expect(actionsFor(container({ State: 'restarting' }))).toContain('stop');
  });

  it('offers a paused container the way out, and not what Docker would refuse', () => {
    const actions = actionsFor(container({ State: 'paused' }));

    // Paused is running, so Start is refused as "already started", and Docker
    // wants a paused container unpaused before it will kill it. Resume comes
    // first because it is the way out of the state.
    expect(actions).not.toContain('start');
    expect(actions).not.toContain('kill');
    expect(actions).toEqual(['unpause', 'stop', 'restart', 'remove']);
  });

  it('does not ask before resuming, as with starting', () => {
    // The worst case of resuming is that nothing happens.
    expect(needsConfirmation('unpause')).toBe(false);
    expect(needsConfirmation('pause')).toBe(true);
  });
});

describe('requiresForceToRemove', () => {
  it.each([['running'], ['restarting'], ['paused']])(
    'requires force to remove a %s container',
    (state) => {
      expect(requiresForceToRemove(container({ State: state }))).toBe(true);
    },
  );

  it.each([['exited'], ['created'], ['dead']])('removes a %s container without force', (state) => {
    expect(requiresForceToRemove(container({ State: state }))).toBe(false);
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

describe('image actions', () => {
  it('offers nothing until the plugin has said what is allowed', () => {
    expect(imageActionState(undefined)).toMatchObject({ enabled: false });
    expect(imageActionState(undefined).reason).toContain('Waiting for the plugin');
  });

  it('needs destructive as well as control', () => {
    expect(imageActionState(control({ allowPutControl: false })).reason).toContain(
      'Container control is disabled',
    );
    // Control alone is not enough: deleting an image costs whatever bandwidth
    // it takes to fetch again, which offshore is none.
    expect(imageActionState(control({ allowDestructive: false })).reason).toContain(
      'Destructive operations are disabled',
    );
    expect(imageActionState(control({ allowDestructive: true })).enabled).toBe(true);
  });

  it('says nothing about self-protection, which Docker enforces here', () => {
    // The image Signal K runs from is held by a container, and Docker refuses
    // to remove an image any container holds. Nothing in the panel has to know
    // which image that is.
    const allowed = control({ allowDestructive: true, allowSelfManagement: false });
    expect(imageActionState(allowed).enabled).toBe(true);
  });

  it('sends a registry tag as one path segment', () => {
    // Unencoded, the slashes would arrive as more path and the route would
    // never match; the colon would split the tag off the name.
    expect(imageRequest('remove', 'ghcr.io/owner/app:1.2')).toEqual({
      method: 'DELETE',
      path: `/images/${encodeURIComponent('ghcr.io/owner/app:1.2')}`,
    });
  });

  it('never widens a prune by default', () => {
    // ?all= is spelled out both ways rather than omitted: the facade reads the
    // narrow prune from the absence of the flag, and a request that means to
    // say "untagged only" should say it.
    expect(imageRequest('prune', { all: false })).toEqual({
      method: 'POST',
      path: '/images/prune?all=false',
    });
    expect(imageRequest('prune', { all: true }).path).toBe('/images/prune?all=true');
  });

  it('labels both actions in the operator’s words', () => {
    expect(imageActionLabel('remove')).toBe('Delete');
    expect(imageActionLabel('prune')).toBe('Reclaim space');
  });
});
