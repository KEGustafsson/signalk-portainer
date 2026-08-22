import type { DockerContainer } from '../types';

/**
 * What the server says the panel may offer, and the rules for turning that into
 * enabled or disabled buttons.
 *
 * These rules are a mirror of the guards in the facade, never a substitute:
 * every one of them is enforced again server-side. Their job here is to explain
 * — a disabled button says why, instead of a click ending in a 403.
 */

export interface ControlSelf {
  inContainer: boolean;
  identified: boolean;
  shortId?: string;
  source: string;
  protectionActive: boolean;
  warning?: string;
}

export interface ControlState {
  allowPutControl: boolean;
  allowDestructive: boolean;
  allowSelfManagement: boolean;
  self: ControlSelf;
}

/**
 * The facade's answer, made safe to read.
 *
 * The panel is one component in someone else's admin UI: a partial body, or a
 * proxy answering with something else entirely, must not take the page down.
 * Anything missing reads as "not allowed", which is the safe direction.
 */
export function normalizeControl(body: unknown): ControlState | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = body as Record<string, unknown>;
  const self = (typeof raw.self === 'object' && raw.self !== null ? raw.self : {}) as Record<
    string,
    unknown
  >;
  return {
    allowPutControl: raw.allowPutControl === true,
    allowDestructive: raw.allowDestructive === true,
    allowSelfManagement: raw.allowSelfManagement === true,
    self: {
      inContainer: self.inContainer === true,
      identified: self.identified === true,
      shortId: typeof self.shortId === 'string' ? self.shortId : undefined,
      source: typeof self.source === 'string' ? self.source : 'none',
      protectionActive: self.protectionActive === true,
      warning: typeof self.warning === 'string' ? self.warning : undefined,
    },
  };
}

export const CONTAINER_ACTIONS = [
  'start',
  'stop',
  'restart',
  'kill',
  'pause',
  'unpause',
  'remove',
] as const;
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number];

export interface ActionState {
  enabled: boolean;
  /** Why it is disabled, shown as the button's tooltip. */
  reason?: string;
}

const LABELS: Record<ContainerAction, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  kill: 'Kill',
  pause: 'Pause',
  unpause: 'Resume',
  remove: 'Remove',
};

export function actionLabel(action: ContainerAction): string {
  return LABELS[action];
}

/** Whether this row is the container Signal K itself runs in. */
export function isSelfRow(control: ControlState | undefined, containerId: string): boolean {
  const known = control?.self.shortId;
  if (!known || !control?.self.identified) return false;
  return containerId.toLowerCase().startsWith(known.toLowerCase());
}

/**
 * Docker refuses to remove a container that is not fully stopped — paused
 * counts as running to the daemon — so those removals need force. The dialog
 * and the button share this rule rather than each deciding for itself.
 */
export function requiresForceToRemove(container: DockerContainer): boolean {
  return (
    container.State === 'running' ||
    container.State === 'restarting' ||
    container.State === 'paused'
  );
}

/**
 * Which actions are worth showing for a container in this state.
 *
 * A stopped container has nothing to stop or kill, and offering it reads as a
 * bug rather than as a safeguard. Restart is offered only for a running
 * container for the same reason: Docker would start a stopped one, which is not
 * what the word says.
 *
 * A paused container is running, so Start would be refused as "already
 * started" and Kill as "unpause it first". What it actually needs is Resume,
 * which is offered first because it is the way out of the paused state.
 */
export function actionsFor(container: DockerContainer): ContainerAction[] {
  switch (container.State) {
    case 'running':
    case 'restarting':
      return ['stop', 'restart', 'pause', 'kill', 'remove'];
    case 'paused':
      return ['unpause', 'stop', 'restart', 'remove'];
    default:
      return ['start', 'remove'];
  }
}

/** Whether an action may be offered, and the reason when it may not. */
export function actionState(
  control: ControlState | undefined,
  container: DockerContainer,
  action: ContainerAction,
): ActionState {
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
  if (action === 'remove' && !control.allowDestructive) {
    return {
      enabled: false,
      reason:
        'Destructive operations are disabled — enable "Allow destructive operations" in the plugin configuration',
    };
  }
  if (isSelfRow(control, container.Id) && !control.allowSelfManagement) {
    return {
      enabled: false,
      reason:
        'This is the container running Signal K; acting on it would stop this page. Enable "Allow managing the Signal K container itself" to override',
    };
  }
  return { enabled: true };
}

/**
 * Actions that interrupt something already running need a confirmation step.
 * Starting a container does not: it is the one action whose worst case is that
 * nothing happens.
 */
export function needsConfirmation(action: ContainerAction): boolean {
  // Resuming a paused container is the same kind of act as starting a stopped
  // one: the worst case is that nothing happens.
  return action !== 'start' && action !== 'unpause';
}

/** Bootstrap button styling: destructive actions must not look routine. */
export function actionVariant(action: ContainerAction): string {
  switch (action) {
    case 'start':
    case 'unpause':
      return 'outline-success';
    case 'kill':
    case 'remove':
      return 'outline-danger';
    default:
      return 'outline-secondary';
  }
}

export interface RemoveOptions {
  force: boolean;
  removeVolumes: boolean;
}

/** The facade path for an action, with removal's options made explicit. */
export function actionRequest(
  containerId: string,
  action: ContainerAction,
  options: RemoveOptions = { force: false, removeVolumes: false },
): { method: 'POST' | 'DELETE'; path: string } {
  const id = encodeURIComponent(containerId);
  if (action !== 'remove') return { method: 'POST', path: `/containers/${id}/${action}` };
  return {
    method: 'DELETE',
    path: `/containers/${id}?force=${options.force}&removeVolumes=${options.removeVolumes}`,
  };
}
