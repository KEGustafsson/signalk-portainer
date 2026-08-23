/**
 * The parts of the console that do not need a DOM or a socket.
 *
 * The dialog is a terminal and a WebSocket; everything it decides — whether to
 * offer a shell at all, what URL to open, what to make of the server's answer,
 * and what to tell the operator when the socket closes — lives here, where it
 * can be tested without either.
 */

import type { DockerContainer } from '../types';
import { isSelfRow, type ControlState } from './control';

/** Where the plugin's WebSocket endpoint is registered on the Signal K server. */
export const CONSOLE_PATH = '/plugins/signalk-portainer/console';

/**
 * The shells worth offering.
 *
 * `/bin/sh` first because it is the one present in every image worth opening a
 * shell in — bash is absent from Alpine, which most of these containers are.
 */
export const SHELL_CHOICES = [
  { label: '/bin/sh', command: ['/bin/sh'] },
  { label: '/bin/bash', command: ['/bin/bash'] },
  { label: '/bin/ash', command: ['/bin/ash'] },
] as const;

export const DEFAULT_SHELL = SHELL_CHOICES[0].label;

/** The command for a shell the operator picked, or the default for anything else. */
export function commandFor(label: string): string[] {
  const choice = SHELL_CHOICES.find((candidate) => candidate.label === label);
  return [...(choice ?? SHELL_CHOICES[0]).command];
}

/** Whether a console may be offered for this container, and why not when it may not. */
export function consoleState(
  control: ControlState | undefined,
  container: DockerContainer,
): { enabled: boolean; reason?: string } {
  if (!control) {
    return { enabled: false, reason: 'Waiting for the plugin to report what is allowed' };
  }
  if (!control.allowPutControl) {
    return {
      enabled: false,
      reason:
        'Container control is disabled — enable "Allow Signal K PUT control" in the plugin configuration',
    };
  }
  if (!control.console.available) {
    return {
      enabled: false,
      reason: control.console.reason
        ? `The console is not available: ${control.console.reason}`
        : 'The console is not available on this Signal K server',
    };
  }
  if (container.State !== 'running') {
    // Docker refuses an exec in a container that is not running, and the
    // refusal arrives as a 409 after the dialog has already opened.
    return { enabled: false, reason: 'The container is not running' };
  }
  if (isSelfRow(control, container.Id) && !control.allowSelfManagement) {
    return {
      enabled: false,
      reason:
        'This is the container running Signal K; a shell in it can stop this page. Enable "Allow managing the Signal K container itself" to override',
    };
  }
  return { enabled: true };
}

/** What the server said when it minted a ticket. */
export interface ConsoleTicket {
  ticket: string;
  session: string;
  command: string[];
}

/**
 * The ticket out of the facade's answer.
 *
 * The panel runs inside someone else's admin UI, and a body that is missing a
 * field must read as "no shell" rather than open a socket with `undefined` in
 * the query.
 */
export function normalizeTicket(body: unknown): ConsoleTicket | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = body as Record<string, unknown>;
  if (typeof raw.ticket !== 'string' || raw.ticket.length === 0) return undefined;
  if (typeof raw.session !== 'string' || raw.session.length === 0) return undefined;
  const command = Array.isArray(raw.command)
    ? raw.command.filter((part): part is string => typeof part === 'string')
    : [];
  return { ticket: raw.ticket, session: raw.session, command };
}

/**
 * The socket URL for a ticket.
 *
 * Same origin as the page, because that is where Signal K serves the plugin —
 * and `wss` whenever the page is `https`, since a browser refuses an insecure
 * socket from a secure page and the failure it gives says nothing useful.
 */
export function socketUrl(
  ticket: string,
  location: { protocol: string; host: string } = window.location,
): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${CONSOLE_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * The close codes the relay uses, mirrored from the server.
 *
 * These are in the private 4000-4999 range, which is the only range a
 * WebSocket application may define, so nothing else can produce them.
 */
export const RELAY_CLOSE = {
  unauthorized: 4401,
  refused: 4403,
  upstream: 4502,
  idle: 4408,
} as const;

/** Whether a close was the ordinary end of a shell rather than a failure. */
export function isNormalClose(code: number): boolean {
  return code === 1000 || code === 1005;
}

/**
 * What to tell the operator about a socket that closed.
 *
 * A bare code is useless to the person holding the boat, and the browser's own
 * message for an abnormal close is empty, so every case that can actually
 * happen gets a sentence that says what to do about it.
 */
export function closeMessage(code: number, reason?: string): string {
  switch (code) {
    case RELAY_CLOSE.unauthorized:
      return 'The console ticket was refused. It is good for one shell and only for a moment — open the terminal again.';
    case RELAY_CLOSE.refused:
      return 'The plugin refused the shell. Either too many consoles are open already, or the plugin stopped while this one was connecting.';
    case RELAY_CLOSE.upstream:
      return 'The shell could not be opened. Portainer may be unreachable, or the container may have stopped.';
    case RELAY_CLOSE.idle:
      return 'The console was closed after sitting idle. A forgotten shell holds a process in the container, so it does not stay open indefinitely.';
    case 1006:
      // The browser's code for a connection that dropped without a close
      // frame, which is what a lost link or a proxy timeout looks like.
      return 'The connection to Signal K was lost.';
    default:
      if (isNormalClose(code)) return 'The shell exited.';
      return reason && reason.length > 0
        ? `The console closed: ${reason}`
        : `The console closed (code ${code}).`;
  }
}
