import type { DockerContainer } from '../../src/types';
import type { ControlState } from '../../src/webapp/control';
import {
  RELAY_CLOSE,
  SHELL_CHOICES,
  closeMessage,
  commandFor,
  consoleState,
  isNormalClose,
  normalizeTicket,
  socketUrl,
} from '../../src/webapp/consolesession';

const control = (overrides: Partial<ControlState> = {}): ControlState => ({
  allowPutControl: true,
  allowDestructive: false,
  allowSelfManagement: false,
  console: { available: true },
  self: {
    inContainer: true,
    identified: true,
    shortId: 'a1b2c3d4e5f6',
    source: 'cgroup',
    protectionActive: true,
  },
  ...overrides,
});

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer =>
  ({
    Id: 'c1f0e2a3b4c5d6e7f8a9b0c1',
    Names: ['/mosquitto'],
    Image: 'eclipse-mosquitto',
    State: 'running',
    Status: 'Up 2 hours',
    ...overrides,
  }) as DockerContainer;

describe('consoleState', () => {
  it('offers a shell in a running container', () => {
    expect(consoleState(control(), container())).toEqual({ enabled: true });
  });

  it('waits rather than guessing before the plugin has answered', () => {
    const state = consoleState(undefined, container());

    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('Waiting');
  });

  it('says so when control is disabled', () => {
    const state = consoleState(control({ allowPutControl: false }), container());

    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('Allow Signal K PUT control');
  });

  it('never offers a console the server said it cannot serve', () => {
    // The one case an operator cannot fix from the plugin configuration, so
    // the server's own words are passed through.
    const state = consoleState(
      control({
        console: {
          available: false,
          reason: 'this Signal K server cannot serve a plugin WebSocket',
        },
      }),
      container(),
    );

    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('cannot serve a plugin WebSocket');
  });

  it('still refuses when the server gave no reason', () => {
    const state = consoleState(control({ console: { available: false } }), container());

    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('not available');
  });

  it('does not offer a shell in a container that is not running', () => {
    // Docker refuses the exec with a 409, which would arrive after the dialog
    // had already opened and looked like a bug in the plugin.
    for (const State of ['exited', 'created', 'paused'] as const) {
      expect(consoleState(control(), container({ State })).enabled).toBe(false);
    }
  });

  it('refuses a shell in the Signal K container', () => {
    const state = consoleState(control(), container({ Id: 'a1b2c3d4e5f6a7b8' }));

    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('stop this page');
  });

  it('offers it once self-management is allowed', () => {
    const state = consoleState(
      control({ allowSelfManagement: true }),
      container({ Id: 'a1b2c3d4e5f6a7b8' }),
    );

    expect(state.enabled).toBe(true);
  });
});

describe('commandFor', () => {
  it('gives the argv for a shell that was offered', () => {
    expect(commandFor('/bin/bash')).toEqual(['/bin/bash']);
  });

  it('falls back to sh for anything else', () => {
    // Nothing should reach this, but a stale select value must not send a
    // command the server will refuse.
    expect(commandFor('/bin/nonesuch')).toEqual(['/bin/sh']);
    expect(commandFor('')).toEqual(['/bin/sh']);
  });

  it('offers sh first, because it is the one every image has', () => {
    expect(SHELL_CHOICES[0].label).toBe('/bin/sh');
  });

  it('gives back a copy, not the constant', () => {
    const command = commandFor('/bin/sh');
    command.push('-c');

    expect(commandFor('/bin/sh')).toEqual(['/bin/sh']);
  });
});

describe('normalizeTicket', () => {
  it('reads the ticket, the session and the command', () => {
    expect(
      normalizeTicket({ id: 'abc', ticket: 'tkt', session: 'ses', command: ['/bin/sh'] }),
    ).toEqual({ ticket: 'tkt', session: 'ses', command: ['/bin/sh'] });
  });

  it('is nothing without both handles', () => {
    // A socket opened with `undefined` in the query is refused by the server
    // with a message about tickets, which reads as a bug rather than a body
    // that arrived misshapen.
    expect(normalizeTicket({ session: 'ses' })).toBeUndefined();
    expect(normalizeTicket({ ticket: 'tkt' })).toBeUndefined();
    expect(normalizeTicket({ ticket: '', session: 'ses' })).toBeUndefined();
    expect(normalizeTicket({ ticket: 'tkt', session: '' })).toBeUndefined();
    expect(normalizeTicket({ ticket: 5, session: 'ses' })).toBeUndefined();
    expect(normalizeTicket(undefined)).toBeUndefined();
    expect(normalizeTicket('tkt')).toBeUndefined();
    expect(normalizeTicket(null)).toBeUndefined();
  });

  it('takes a missing or misshapen command as no command', () => {
    expect(normalizeTicket({ ticket: 'tkt', session: 'ses' })?.command).toEqual([]);
    expect(normalizeTicket({ ticket: 'tkt', session: 'ses', command: 'sh' })?.command).toEqual([]);
    expect(
      normalizeTicket({ ticket: 'tkt', session: 'ses', command: ['/bin/sh', 7] })?.command,
    ).toEqual(['/bin/sh']);
  });
});

describe('socketUrl', () => {
  it('opens wss from a page served over https', () => {
    // A browser refuses an insecure socket from a secure page, and says
    // nothing useful about why.
    expect(socketUrl('tkt', { protocol: 'https:', host: 'boat.local:3443' })).toBe(
      'wss://boat.local:3443/plugins/signalk-portainer/console?ticket=tkt',
    );
  });

  it('opens ws from a page served over http', () => {
    expect(socketUrl('tkt', { protocol: 'http:', host: 'localhost:3000' })).toBe(
      'ws://localhost:3000/plugins/signalk-portainer/console?ticket=tkt',
    );
  });

  it('escapes the ticket', () => {
    expect(socketUrl('a b&c', { protocol: 'http:', host: 'h' })).toContain('ticket=a%20b%26c');
  });
});

describe('closeMessage', () => {
  it('explains a refused ticket without inviting a retry of the same one', () => {
    expect(closeMessage(RELAY_CLOSE.unauthorized)).toContain('one shell');
  });

  it('explains a refusal', () => {
    expect(closeMessage(RELAY_CLOSE.refused)).toContain('too many consoles');
  });

  it('explains a shell that could not be opened', () => {
    expect(closeMessage(RELAY_CLOSE.upstream)).toContain('Portainer');
  });

  it('explains the idle timeout as a deliberate thing', () => {
    expect(closeMessage(RELAY_CLOSE.idle)).toContain('idle');
  });

  it('says the link was lost for a connection that just dropped', () => {
    expect(closeMessage(1006)).toContain('lost');
  });

  it('says the shell exited for an ordinary close', () => {
    expect(closeMessage(1000)).toBe('The shell exited.');
    expect(closeMessage(1005)).toBe('The shell exited.');
    expect(isNormalClose(1000)).toBe(true);
    expect(isNormalClose(RELAY_CLOSE.idle)).toBe(false);
  });

  it('passes an unfamiliar close through rather than swallowing it', () => {
    expect(closeMessage(1011, 'internal error')).toContain('internal error');
    expect(closeMessage(1011)).toContain('1011');
  });
});
