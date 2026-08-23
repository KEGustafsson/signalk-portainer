import type { Stack } from '../../src/types';
import type { ControlState } from '../../src/webapp/control';
import {
  envForRequest,
  envOf,
  hasChanges,
  isActive,
  isFromGit,
  nameProblem,
  normalizeStackFile,
  normalizeStacks,
  stackActionLabel,
  stackActionState,
  stackActionsFor,
} from '../../src/webapp/stackcontrol';

const stack = (overrides: Partial<Stack> = {}): Stack => ({
  Id: 3,
  Name: 'signalk',
  Type: 2,
  EndpointId: 1,
  Status: 1,
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
    source: 'cgroup',
    protectionActive: true,
  },
  ...overrides,
});

describe('stackActionsFor', () => {
  it('offers stop for a running stack and start for a stopped one', () => {
    // Never both: Docker refuses the one that does not apply, and a button
    // that always fails is worse than no button.
    expect(stackActionsFor(stack({ Status: 1 }))).toContain('stop');
    expect(stackActionsFor(stack({ Status: 1 }))).not.toContain('start');
    expect(stackActionsFor(stack({ Status: 2 }))).toContain('start');
    expect(stackActionsFor(stack({ Status: 2 }))).not.toContain('stop');
  });

  it('offers redeploy only for a stack with a repository', () => {
    expect(stackActionsFor(stack())).not.toContain('redeploy');
    expect(stackActionsFor(stack({ GitConfig: { URL: 'https://example.test/stacks' } }))).toContain(
      'redeploy',
    );
  });

  it('leaves start and stop off a kubernetes stack', () => {
    // The plugin's routes go through Portainer's compose and swarm paths.
    const actions = stackActionsFor(stack({ Type: 3 }));
    expect(actions).not.toContain('start');
    expect(actions).not.toContain('stop');
    expect(actions).toEqual(['edit', 'delete']);
  });

  it('always offers edit and delete', () => {
    expect(stackActionsFor(stack())).toContain('edit');
    expect(stackActionsFor(stack())).toContain('delete');
  });
});

describe('stackActionState', () => {
  it('keeps edit available even with control disabled', () => {
    // Reading the compose file of a running stack is worth doing on a server
    // nobody is allowed to change.
    const state = stackActionState(control({ allowPutControl: false }), stack(), 'edit');
    expect(state.enabled).toBe(true);
  });

  it('disables everything else while control is disabled, and says which setting', () => {
    const state = stackActionState(control({ allowPutControl: false }), stack(), 'stop');
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('Allow Signal K PUT control');
  });

  it('offers nothing until the plugin has answered', () => {
    const state = stackActionState(undefined, stack(), 'stop');
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('waiting for the plugin');
  });

  it('needs the destructive setting for delete alone', () => {
    expect(stackActionState(control(), stack(), 'stop').enabled).toBe(true);
    const remove = stackActionState(control(), stack(), 'delete');
    expect(remove.enabled).toBe(false);
    expect(remove.reason).toContain('Allow destructive operations');
    expect(stackActionState(control({ allowDestructive: true }), stack(), 'delete').enabled).toBe(
      true,
    );
  });

  it('refuses a redeploy for a stack with nothing to redeploy from', () => {
    const state = stackActionState(control(), stack(), 'redeploy');
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('no repository');
  });
});

describe('normalizeStacks', () => {
  it('keeps the stacks a response actually carries', () => {
    expect(normalizeStacks({ stacks: [stack(), stack({ Id: 5, Name: 'other' })] })).toHaveLength(2);
  });

  it('renders nothing rather than crashing on a shape it did not expect', () => {
    expect(normalizeStacks({})).toEqual([]);
    expect(normalizeStacks({ stacks: 'nope' })).toEqual([]);
    expect(normalizeStacks(null)).toEqual([]);
  });

  it('drops an entry with no id or no name', () => {
    // These ids are what a delete is sent with; an entry without one is not a
    // row worth rendering a Delete button beside.
    expect(normalizeStacks({ stacks: [{ Name: 'nameless' }, { Id: 4 }, stack()] })).toEqual([
      stack(),
    ]);
  });
});

describe('normalizeStackFile', () => {
  it('reads the file out of a response', () => {
    expect(normalizeStackFile({ content: 'services:\n' })).toBe('services:\n');
  });

  it('is empty for anything else', () => {
    expect(normalizeStackFile({})).toBe('');
    expect(normalizeStackFile(null)).toBe('');
    expect(normalizeStackFile({ content: 42 })).toBe('');
  });
});

describe('environment variables', () => {
  it('reads what the stack was deployed with', () => {
    const rows = envOf(stack({ Env: [{ name: 'TZ', value: 'UTC' }] }));
    expect(rows).toEqual([{ name: 'TZ', value: 'UTC' }]);
  });

  it('drops the blank row an editor leaves behind', () => {
    // Sending it would be refused for having no name.
    expect(
      envForRequest([
        { name: 'TZ', value: 'UTC' },
        { name: '  ', value: 'x' },
      ]),
    ).toEqual([{ name: 'TZ', value: 'UTC' }]);
  });

  it('trims a name but never the value', () => {
    // A trailing space in a value can be deliberate; in a name it is a typo.
    expect(envForRequest([{ name: ' TZ ', value: ' UTC ' }])).toEqual([
      { name: 'TZ', value: ' UTC ' },
    ]);
  });
});

describe('hasChanges', () => {
  const original = { content: 'services:\n', env: [{ name: 'TZ', value: 'UTC' }] };

  it('sees an edited file', () => {
    expect(hasChanges(original, { ...original, content: 'services:\n  web:\n' })).toBe(true);
  });

  it('sees an edited, added or removed variable', () => {
    expect(hasChanges(original, { ...original, env: [{ name: 'TZ', value: 'CET' }] })).toBe(true);
    expect(
      hasChanges(original, { ...original, env: [...original.env, { name: 'A', value: 'b' }] }),
    ).toBe(true);
    expect(hasChanges(original, { ...original, env: [] })).toBe(true);
  });

  it('ignores a blank row that would never be sent', () => {
    expect(
      hasChanges(original, { ...original, env: [...original.env, { name: '', value: '' }] }),
    ).toBe(false);
  });

  it('says nothing changed when nothing did', () => {
    expect(
      hasChanges(original, { content: 'services:\n', env: [{ name: 'TZ', value: 'UTC' }] }),
    ).toBe(false);
  });
});

describe('nameProblem', () => {
  it('accepts the names Docker accepts', () => {
    expect(nameProblem('signalk')).toBeUndefined();
    expect(nameProblem('boat-stack_2.1')).toBeUndefined();
  });

  it('explains the ones it does not', () => {
    expect(nameProblem('')).toContain('needs a name');
    expect(nameProblem('../etc')).toContain('only letters');
    expect(nameProblem('-leading')).toContain('only letters');
    expect(nameProblem('with space')).toContain('only letters');
  });
});

describe('labels and state helpers', () => {
  it('names each action', () => {
    expect(stackActionLabel('redeploy')).toBe('Redeploy');
    expect(stackActionLabel('delete')).toBe('Delete');
  });

  it('reads a stack’s own state', () => {
    expect(isActive(stack({ Status: 1 }))).toBe(true);
    expect(isActive(stack({ Status: 2 }))).toBe(false);
    expect(isFromGit(stack())).toBe(false);
    expect(isFromGit(stack({ GitConfig: { URL: 'https://x.test' } }))).toBe(true);
    expect(isFromGit(stack({ GitConfig: null }))).toBe(false);
  });
});
