import type { Stack } from '../../src/types';
import type { ControlState } from '../../src/webapp/control';
import {
  autoUpdateOf,
  envForRequest,
  envOf,
  envProblem,
  envProblems,
  hasChanges,
  intervalProblem,
  isActive,
  isFromGit,
  nameProblem,
  normalizeStackFile,
  normalizeStacks,
  stackActionLabel,
  stackActionState,
  stackActionsFor,
  webhookUrl,
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
  it('accepts the names compose accepts as a project', () => {
    expect(nameProblem('signalk')).toBeUndefined();
    expect(nameProblem('boat-stack_2')).toBeUndefined();
  });

  it('explains the ones it does not', () => {
    expect(nameProblem('')).toContain('needs a name');
    expect(nameProblem('../etc')).toContain('only lowercase letters');
    expect(nameProblem('-leading')).toContain('only lowercase letters');
    expect(nameProblem('with space')).toContain('only lowercase letters');
  });

  it('refuses what Portainer’s own form refuses, rather than letting it be rewritten', () => {
    // Compose lowercases a project name and drops a dot; which of those a
    // Portainer does depends on its version, so the operator would get a
    // stack named something they never typed, or a 400 after filling in the
    // whole form.
    expect(nameProblem('SignalK')).toContain('lowercase');
    expect(nameProblem('boat.stack')).toContain('lowercase');
  });
});

describe('envProblem', () => {
  const rows = (...entries: [string, string][]) =>
    entries.map(([name, value]) => ({ name, value }));

  it('passes an ordinary variable, and an untouched blank row', () => {
    expect(envProblem(rows(['TZ', 'Europe/Helsinki']), 0)).toBeUndefined();
    expect(envProblem(rows(['', '']), 0)).toBeUndefined();
  });

  it('refuses a whole .env line pasted into the name box', () => {
    // Portainer writes these as `NAME=value` lines, so this would define a
    // variable called "TZ=Europe/Helsinki" and nothing useful.
    expect(envProblem(rows(['TZ=Europe/Helsinki', '']), 0)).toMatch(/Letters, digits/);
    expect(envProblem(rows(['2FAST', '']), 0)).toMatch(/Letters, digits/);
  });

  it('refuses a value with no name rather than dropping it silently', () => {
    // `envForRequest` keeps only named rows, so this one would be deployed
    // without the variable the operator typed a value for, and nothing would
    // have said so.
    expect(envProblem(rows(['', 'Europe/Helsinki']), 0)).toMatch(/needs a name/);
    expect(envProblem(rows(['  ', 'Europe/Helsinki']), 0)).toMatch(/needs a name/);
    expect(envForRequest(rows(['', 'Europe/Helsinki']))).toEqual([]);
  });

  it('refuses the same variable twice, since only one of them would survive', () => {
    expect(envProblem(rows(['TZ', 'a'], ['TZ', 'b']), 1)).toMatch(/twice/);
    expect(envProblem(rows(['TZ', 'a'], ['TZ', 'b']), 0)).toBeUndefined();
  });

  it('refuses a line break in a value, which would define a second variable', () => {
    expect(envProblem(rows(['TZ', 'a\nDB=secret']), 0)).toMatch(/line break/);
  });

  it('reports the first thing wrong with the whole list', () => {
    expect(envProblems(rows(['TZ', 'ok'], ['BAD NAME', 'x']))).toMatch(/BAD NAME/);
    expect(envProblems(rows(['TZ', 'ok']))).toBeUndefined();
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

describe('auto-update', () => {
  const git = { URL: 'https://example.test/boat/stacks', ReferenceName: 'refs/heads/main' };

  it('is offered only for a stack with a repository', () => {
    // Portainer accepts the setting on its git create routes and nowhere
    // else, and the route that changes it refuses a stack with no repository
    // config — so a file-based stack has nothing to offer.
    expect(stackActionsFor(stack())).not.toContain('autoupdate');
    expect(stackActionsFor(stack({ GitConfig: git }))).toContain('autoupdate');
  });

  it('needs control, but is not destructive', () => {
    // Nothing is deleted by a schedule. What it changes is who deploys the
    // stack, which is exactly what control governs.
    expect(
      stackActionState(control({ allowPutControl: false }), stack({ GitConfig: git }), 'autoupdate')
        .enabled,
    ).toBe(false);
    expect(
      stackActionState(
        control({ allowDestructive: false }),
        stack({ GitConfig: git }),
        'autoupdate',
      ).enabled,
    ).toBe(true);
  });

  it('says why a file-based stack cannot have it', () => {
    const state = stackActionState(control(), stack(), 'autoupdate');
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/repository/);
  });

  it('is named in the row', () => {
    expect(stackActionLabel('autoupdate')).toBe('Auto-update');
  });

  describe('autoUpdateOf', () => {
    it('reads what the stack reports', () => {
      expect(
        autoUpdateOf(
          stack({
            AutoUpdate: { Interval: '30m', Webhook: 'abc', ForcePullImage: true, JobID: '4' },
          }),
        ),
      ).toEqual({ interval: '30m', webhook: 'abc', pullImage: true, force: false });
    });

    it('reads a stack with none as off rather than as unknown', () => {
      // Portainer sends `null` for a stack that has none, and an empty string
      // for a trigger it is not using — neither is a setting.
      expect(autoUpdateOf(stack({ AutoUpdate: null }))).toEqual({ pullImage: false, force: false });
      expect(autoUpdateOf(stack({ AutoUpdate: { Interval: '', Webhook: '' } }))).toEqual({
        pullImage: false,
        force: false,
      });
      expect(autoUpdateOf(undefined)).toEqual({ pullImage: false, force: false });
    });
  });

  describe('webhookUrl', () => {
    it('names Portainer’s own route, which the plugin is not in', () => {
      // Whatever pushes to the repository calls this directly; Signal K is
      // not in the path, so the URL has to be Portainer's.
      expect(webhookUrl('https://boat.test:9443', 'abc-123')).toBe(
        'https://boat.test:9443/api/stacks/webhooks/abc-123',
      );
    });

    it('does not double the separator on a configured trailing slash', () => {
      expect(webhookUrl('https://boat.test:9443/', 'abc')).toBe(
        'https://boat.test:9443/api/stacks/webhooks/abc',
      );
    });

    it('gives nothing at all rather than a URL missing its host', () => {
      expect(webhookUrl(undefined, 'abc')).toBeUndefined();
      expect(webhookUrl('', 'abc')).toBeUndefined();
    });
  });

  describe('intervalProblem', () => {
    it('takes the durations Go writes', () => {
      for (const interval of ['1m', '30m', '2h', '1h30m', '90s', '2h15m30s']) {
        expect(intervalProblem(interval)).toBeUndefined();
      }
    });

    it('refuses one shorter than a minute', () => {
      // Portainer hands the string to `time.ParseDuration` and polls at
      // whatever comes out, without looking at it: `0s` is a git fetch as
      // fast as the link allows.
      for (const interval of ['0s', '30s', '59s', '0m', '0h']) {
        expect(intervalProblem(interval)).toMatch(/shortest allowed/);
      }
    });

    it('refuses what is not a duration, including units Go has but this does not', () => {
      for (const interval of ['soon', '30', '5x', '30m1h', '1d', '1000ms', '-5m']) {
        expect(intervalProblem(interval)).toMatch(/Hours, minutes and seconds/);
      }
    });

    it('says nothing about an empty box, which is not yet a mistake', () => {
      expect(intervalProblem('')).toBeUndefined();
      expect(intervalProblem('   ')).toBeUndefined();
    });
  });
});
