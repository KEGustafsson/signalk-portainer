/**
 * What the panel may offer for a stack, and what the facade's answers mean.
 *
 * The same relationship to the server as `control.ts`: these rules explain, and
 * every one of them is enforced again server-side. A disabled button says why
 * rather than leaving a click to end in a 403.
 */

import type { Stack } from '../types';
import type { ControlState } from './control';

export const STACK_ACTIONS = ['edit', 'start', 'stop', 'redeploy', 'autoupdate', 'delete'] as const;
export type StackAction = (typeof STACK_ACTIONS)[number];

const LABELS: Record<StackAction, string> = {
  edit: 'Edit',
  start: 'Start',
  stop: 'Stop',
  redeploy: 'Redeploy',
  autoupdate: 'Auto-update',
  delete: 'Delete',
};

export function stackActionLabel(action: StackAction): string {
  return LABELS[action];
}

/** 1 = swarm, 2 = compose, 3 = kubernetes. */
const KUBERNETES = 3;
/** Portainer's stack status: 1 = active, 2 = inactive. */
const ACTIVE = 1;

export function isActive(stack: Stack): boolean {
  return stack.Status === ACTIVE;
}

/** Whether the stack's file lives in a repository rather than in Portainer. */
export function isFromGit(stack: Stack): boolean {
  return Boolean(stack.GitConfig?.URL);
}

/**
 * The actions worth offering for this stack.
 *
 * A stopped stack is started, a running one is stopped — never both, since
 * Docker refuses the one that does not apply and a button that always fails is
 * worse than no button. Redeploy appears only for a stack that has a repository
 * to redeploy from.
 */
export function stackActionsFor(stack: Stack): StackAction[] {
  const actions: StackAction[] = ['edit'];
  if (stack.Type !== KUBERNETES) actions.push(isActive(stack) ? 'stop' : 'start');
  // Both only for a git stack: there is nothing to redeploy from otherwise,
  // and auto-update is Portainer re-reading the repository, which a stack
  // without one cannot do. Portainer accepts the setting on its git create
  // routes and nowhere else.
  if (isFromGit(stack)) actions.push('redeploy', 'autoupdate');
  actions.push('delete');
  return actions;
}

export interface StackActionState {
  enabled: boolean;
  /** Why it is disabled, shown as the button's tooltip. */
  reason?: string;
}

/**
 * Why every stack action is refused when PUT control is off.
 *
 * Exported because the panel gates "New stack" on the same setting without
 * having a stack to ask about, and two copies of this sentence drift into two
 * different explanations for one switch.
 */
export const STACK_CONTROL_DISABLED =
  'stack control is disabled; enable "Allow Signal K PUT control" in the plugin configuration';

/**
 * Whether the panel may offer this action, and what to say when it may not.
 *
 * Editing is a read until the operator presses Deploy, so it stays available
 * with control disabled — the compose file of a running stack is worth seeing
 * on a server nobody is allowed to change.
 */
export function stackActionState(
  control: ControlState | undefined,
  stack: Stack,
  action: StackAction,
): StackActionState {
  if (action === 'edit') return { enabled: true };

  if (!control) {
    return { enabled: false, reason: 'waiting for the plugin to report what is allowed' };
  }
  if (!control.allowPutControl) {
    return { enabled: false, reason: STACK_CONTROL_DISABLED };
  }
  if (action === 'delete' && !control.allowDestructive) {
    return {
      enabled: false,
      reason:
        'deleting a stack is destructive; enable "Allow destructive operations" in the plugin configuration',
    };
  }
  if (action === 'redeploy' && !isFromGit(stack)) {
    return { enabled: false, reason: 'this stack has no repository to redeploy from' };
  }
  if (action === 'autoupdate' && !isFromGit(stack)) {
    return {
      enabled: false,
      reason: 'auto-update re-reads the stack’s repository, and this stack has none',
    };
  }
  return { enabled: true };
}

/** Auto-update as the stack reports it, or undefined when it has none. */
export interface AutoUpdateState {
  interval?: string;
  webhook?: string;
  pullImage: boolean;
  force: boolean;
}

/** What the stack currently has, in the shape the dialog edits. */
export function autoUpdateOf(stack: Stack | undefined): AutoUpdateState {
  const held = stack?.AutoUpdate ?? undefined;
  return {
    ...(typeof held?.Interval === 'string' && held.Interval !== ''
      ? { interval: held.Interval }
      : {}),
    ...(typeof held?.Webhook === 'string' && held.Webhook !== '' ? { webhook: held.Webhook } : {}),
    pullImage: held?.ForcePullImage === true,
    force: held?.ForceUpdate === true,
  };
}

/**
 * Where a webhook fires.
 *
 * Portainer's route, not the plugin's: the operator pastes this into GitHub or
 * whatever else pushes to the repository, and the request goes straight to
 * Portainer without Signal K in the path. Built in one place because the
 * dialog shows it both for a webhook that already exists and for one just
 * created, and two copies of a URL drift into one that does not work.
 */
export function webhookUrl(baseUrl: string | undefined, webhook: string): string | undefined {
  const base = (baseUrl ?? '').replace(/\/+$/, '');
  if (base === '') return undefined;
  return `${base}/api/stacks/webhooks/${webhook}`;
}

/**
 * Why an interval will not be accepted, or undefined when it will.
 *
 * The same grammar and the same floor the facade applies, so a typo is caught
 * under the box that produced it rather than as a 400 after the press. Go's
 * duration units, narrowed to the three worth offering: Portainer hands the
 * string to `time.ParseDuration`, and its scheduler polls at whatever comes
 * out — `0s` included.
 */
export function intervalProblem(interval: string): string | undefined {
  const trimmed = interval.trim();
  if (trimmed === '') return undefined;
  if (!/^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(trimmed)) {
    return 'Hours, minutes and seconds, like 30m, 2h or 1h30m';
  }
  const unit = (suffix: string): number =>
    Number(new RegExp(`(\\d+)${suffix}`).exec(trimmed)?.[1] ?? 0);
  const seconds = (unit('h') * 60 + unit('m')) * 60 + unit('s');
  if (seconds < 60) return 'A poll is a git fetch over this link; a minute is the shortest allowed';
  return undefined;
}

/** One environment variable as the editor holds it. */
export interface EnvVar {
  name: string;
  value: string;
}

/**
 * The stacks in a facade response, made safe to render.
 *
 * As everywhere in the panel: a shape that is not what was expected renders as
 * nothing rather than taking the page down.
 */
export function normalizeStacks(body: unknown): Stack[] {
  if (typeof body !== 'object' || body === null) return [];
  const stacks = (body as { stacks?: unknown }).stacks;
  if (!Array.isArray(stacks)) return [];
  return stacks.filter(
    (stack): stack is Stack =>
      typeof stack === 'object' &&
      stack !== null &&
      typeof (stack as Stack).Id === 'number' &&
      typeof (stack as Stack).Name === 'string',
  );
}

/** The compose file out of a facade response. */
export function normalizeStackFile(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const content = (body as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

/** A stack's environment, in the order Portainer holds it. */
export function envOf(stack: Stack | undefined): EnvVar[] {
  return (stack?.Env ?? [])
    .filter((entry) => typeof entry?.name === 'string' && entry.name.length > 0)
    .map((entry) => ({ name: entry.name, value: String(entry.value ?? '') }));
}

/**
 * The environment as the facade takes it, with blank rows dropped.
 *
 * An empty row is what an editor leaves behind when the operator adds one and
 * changes their mind; sending it back would be refused for having no name.
 */
export function envForRequest(rows: readonly EnvVar[]): EnvVar[] {
  return rows
    .filter((row) => row.name.trim().length > 0)
    .map((row) => ({ name: row.name.trim(), value: row.value }));
}

/** Whether anything in the editor differs from what the stack was serving. */
export function hasChanges(
  original: { content: string; env: readonly EnvVar[] },
  edited: { content: string; env: readonly EnvVar[] },
): boolean {
  if (original.content !== edited.content) return true;
  const before = envForRequest(original.env);
  const after = envForRequest(edited.env);
  if (before.length !== after.length) return true;
  return before.some(
    (entry, index) => entry.name !== after[index]?.name || entry.value !== after[index]?.value,
  );
}

/**
 * What a stack name may contain, matching the facade's own rule — which is
 * compose's rule for a project name, because that is what Portainer turns a
 * stack name into. Uppercase and dots are what Portainer's own form refuses,
 * and what a version that does not refuse them silently rewrites.
 */
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Why this name would be refused, or undefined when it would not be. */
export function nameProblem(name: string): string | undefined {
  if (name.length === 0) return 'A stack needs a name';
  if (!NAME.test(name)) {
    return 'A name may contain only lowercase letters, digits, dash and underscore, and must start with a letter or digit';
  }
  return undefined;
}

/** What an environment variable name may be, as the facade and compose read it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why this environment row would be refused, or undefined when it would not.
 *
 * Portainer writes these as `NAME=value` lines into the stack's env file, so
 * a whole `.env` line pasted into the name box, or a value with a line break
 * in it, quietly defines a second variable nobody set. A duplicate name is
 * refused for the same reason: only one of the two would survive, and which
 * one depends on the version.
 */
export function envProblem(rows: readonly EnvVar[], index: number): string | undefined {
  const row = rows[index];
  if (!row) return undefined;
  const name = row.name.trim();
  // An untouched blank row is not a mistake; `envForRequest` drops it. A row
  // with a value and no name is a different thing: dropping that one silently
  // deploys the stack without a variable the operator typed a value for.
  if (name.length === 0) {
    return row.value.length === 0 ? undefined : 'A value needs a name';
  }
  if (!ENV_NAME.test(name)) {
    return 'Letters, digits and underscore only, and not starting with a digit';
  }
  if (rows.some((other, at) => at < index && other.name.trim() === name)) {
    return 'This variable is listed twice';
  }
  if (/[\r\n]/.test(row.value)) return 'A value cannot contain a line break';
  return undefined;
}

/** The first thing wrong with the environment as a whole, if anything is. */
export function envProblems(rows: readonly EnvVar[]): string | undefined {
  for (let index = 0; index < rows.length; index += 1) {
    const problem = envProblem(rows, index);
    if (problem) return `${rows[index]?.name.trim() ?? ''}: ${problem}`;
  }
  return undefined;
}
