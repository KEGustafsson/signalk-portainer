import type { DockerContainer } from './types';

/**
 * Turning Docker's identifiers into Signal K paths.
 *
 * The hard requirement is stability: a path that moves when `docker compose up`
 * recreates a container takes every dashboard gauge and every logged history
 * with it. Container ids change on every recreate and names often follow, so
 * neither is the first choice.
 */

const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_SERVICE = 'com.docker.compose.service';
const SWARM_NAMESPACE = 'com.docker.stack.namespace';
const SWARM_SERVICE = 'com.docker.swarm.service.name';

/**
 * A Signal K path segment: lowercase, alphanumerics and underscores only.
 *
 * Signal K paths are dot-separated, so a dot inside a segment would silently
 * graft a container onto a deeper level of the tree.
 */
export function normalizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'unknown';
}

/** Where a container's key came from, for diagnostics and for the tests. */
export type KeySource = 'compose' | 'swarm' | 'name' | 'id';

export interface ContainerKey {
  key: string;
  source: KeySource;
}

/**
 * The stable identity of a container, in the order of preference set out in
 * docs/plan.md §10 D4.
 *
 * Compose and Swarm service identity both survive a recreate; the container
 * name usually does too, for anything started by hand. The short id is the last
 * resort — it changes on every recreate, but a path that moves beats no path.
 */
export function containerKey(container: DockerContainer): ContainerKey {
  const labels = container.Labels ?? {};

  const project = labels[COMPOSE_PROJECT]?.trim();
  const service = labels[COMPOSE_SERVICE]?.trim();
  if (project && service) {
    return { key: `${normalizeSegment(project)}_${normalizeSegment(service)}`, source: 'compose' };
  }

  // Swarm's own service name is already "<stack>_<service>", so the namespace
  // is not prepended again.
  const swarmService = labels[SWARM_SERVICE]?.trim();
  if (swarmService) return { key: normalizeSegment(swarmService), source: 'swarm' };

  const namespace = labels[SWARM_NAMESPACE]?.trim();
  if (namespace && service) {
    return { key: `${normalizeSegment(namespace)}_${normalizeSegment(service)}`, source: 'swarm' };
  }

  const name = container.Names?.[0]?.replace(/^\//, '').trim();
  if (name) {
    const normalized = normalizeSegment(name);
    if (normalized !== 'unknown') return { key: normalized, source: 'name' };
  }

  return { key: normalizeSegment(container.Id.slice(0, 12)), source: 'id' };
}

/**
 * Two containers can normalise to the same key — a name of `ais-logger`
 * alongside one of `ais_logger`, or the same compose project run twice. Silently
 * publishing both onto one path would make the value flicker between them, so
 * collisions are broken deterministically by appending the short id.
 *
 * Sorted by container id first, so the same set of containers always produces
 * the same assignment regardless of the order Docker listed them in.
 */
export function assignKeys(containers: DockerContainer[]): Map<string, ContainerKey> {
  const byKey = new Map<string, DockerContainer[]>();
  const ordered = [...containers].sort((a, b) => a.Id.localeCompare(b.Id));

  for (const container of ordered) {
    const { key } = containerKey(container);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(container);
    else byKey.set(key, [container]);
  }

  const assigned = new Map<string, ContainerKey>();
  for (const [key, bucket] of byKey) {
    for (const container of bucket) {
      const resolved = containerKey(container);
      assigned.set(
        container.Id,
        bucket.length === 1
          ? resolved
          : {
              key: `${key}_${normalizeSegment(container.Id.slice(0, 12))}`,
              source: resolved.source,
            },
      );
    }
  }
  return assigned;
}

/** Joins a path from already-safe segments. */
export function joinPath(...segments: string[]): string {
  return segments.filter((segment) => segment.length > 0).join('.');
}

/**
 * Docker reports health inside the human-readable status text — "Up 3 days
 * (healthy)" — and nowhere else in the container list. Parsing it here saves an
 * inspect call per container per poll.
 */
export function parseHealth(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const match = /\((health: )?(healthy|unhealthy|starting)\)/i.exec(status);
  return match?.[2]?.toLowerCase();
}
