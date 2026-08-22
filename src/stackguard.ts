/**
 * Whether a stack is the one Signal K runs in.
 *
 * Container self-protection is not enough here. Stopping, redeploying or
 * deleting a stack takes down every container in it, and the operator names the
 * stack rather than the container — so the guard has to be able to answer "is
 * Signal K inside this one?" from the stack's name alone.
 *
 * Docker records the answer on each container as a label: compose writes
 * `com.docker.compose.project`, swarm writes `com.docker.stack.namespace`, and
 * Portainer deploys through one or the other.
 */

import type { DockerContainer } from './types';

/** The labels that say which stack a container belongs to. */
const STACK_LABELS = ['com.docker.compose.project', 'com.docker.stack.namespace'] as const;

/** The stack a container belongs to, if it says. */
export function stackOfContainer(container: DockerContainer): string | undefined {
  for (const label of STACK_LABELS) {
    const value = container.Labels?.[label];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Whether the Signal K container is part of this stack.
 *
 * `containers` is the environment's container list including stopped ones: a
 * Signal K that is currently down is still the thing the operator would lose,
 * and a stack write would bring it back down again.
 *
 * Comparison is case-insensitive because compose lowercases a project name it
 * derives from a directory, while Portainer keeps the stack name as typed.
 */
export function stackHoldsSelf(
  stackName: string,
  selfId: string | undefined,
  containers: readonly DockerContainer[],
): boolean {
  if (!selfId) return false;
  const wanted = stackName.trim().toLowerCase();
  if (wanted.length === 0) return false;

  return containers.some((container) => {
    if (!isSameContainer(container.Id, selfId)) return false;
    const owner = stackOfContainer(container);
    return owner !== undefined && owner.trim().toLowerCase() === wanted;
  });
}

/**
 * Whether two container references name the same container.
 *
 * One of them is usually a short id — 12 characters of the other — so this is a
 * prefix comparison rather than equality, with a floor so a stray short string
 * cannot match everything.
 */
function isSameContainer(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (a.length < 12 || b.length < 12) return false;
  return a.startsWith(b) || b.startsWith(a);
}
