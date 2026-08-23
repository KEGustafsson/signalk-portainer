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
  return segmentOf(value).segment;
}

/** The segment a value with nothing usable left in it collapses to. */
const UNKNOWN_SEGMENT = 'unknown';

/**
 * A normalised segment, and whether anything of the value survived.
 *
 * The two have to be reported separately because the sentinel is itself a legal
 * segment: a container named `unknown` normalises to exactly what `---` does.
 * Testing the string alone sent that container to the short-id fallback, and a
 * short id changes on every recreate, so its path moved every time compose
 * touched it.
 */
function segmentOf(value: string): { segment: string; usable: boolean } {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned ? { segment: cleaned, usable: true } : { segment: UNKNOWN_SEGMENT, usable: false };
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
    const normalized = segmentOf(name);
    if (normalized.usable) return { key: normalized.segment, source: 'name' };
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

  // Every unshared key is claimed before any disambiguated one is built, so a
  // generated key can be checked against all of them. Appending the short id
  // without that check produces a key another container already holds:
  // `/ais-logger` and `/ais_logger` both become `ais_logger_<id>`, and a third
  // container named `/ais-logger-<id>` is already sitting on that path. Both
  // would publish onto it, and a PUT would reach whichever Docker listed last.
  const taken = new Set<string>();
  for (const [key, bucket] of byKey) if (bucket.length === 1) taken.add(key);

  const assigned = new Map<string, ContainerKey>();
  for (const [key, bucket] of byKey) {
    for (const container of bucket) {
      const resolved = containerKey(container);
      const unique = bucket.length === 1 ? key : uniqueKey(key, container.Id, taken);
      taken.add(unique);
      assigned.set(container.Id, { key: unique, source: resolved.source });
    }
  }
  return assigned;
}

/**
 * `<key>_<short id>`, widened until nothing else holds it.
 *
 * The full id is unique, so the widest form always is; the numeric suffix
 * covers the remaining case of a container named after another's disambiguated
 * key. Deterministic given the id-sorted input, so the same set of containers
 * always produces the same assignment.
 */
function uniqueKey(key: string, id: string, taken: ReadonlySet<string>): string {
  const full = normalizeSegment(id);
  for (let width = Math.min(12, full.length); width <= full.length; width += 4) {
    const candidate = `${key}_${full.slice(0, width)}`;
    if (!taken.has(candidate)) return candidate;
  }
  let suffix = 2;
  while (taken.has(`${key}_${full}_${suffix}`)) suffix += 1;
  return `${key}_${full}_${suffix}`;
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

/**
 * Does a configured container reference name this container?
 *
 * An operator may write the key the plugin publishes, the name `docker ps`
 * shows, or an id they copied — so all three are accepted rather than making
 * them discover which one the plugin wanted. Shared by the watchdog and by the
 * PUT allowlist so the two cannot drift into disagreeing about what a
 * reference means.
 */
export function matchesContainerRef(
  container: DockerContainer,
  key: string,
  wanted: string,
): boolean {
  return matchesContainerIdentity(
    { id: container.Id, name: container.Names?.[0]?.replace(/^\//, '') },
    key,
    wanted,
  );
}

/**
 * The same rule over the little that a PUT handler keeps.
 *
 * The PUT side remembers only an id and a name per key, not the whole
 * container, so the rule is written against that and the fuller shape adapts
 * to it — one definition, so the watchdog and the allowlist cannot come to
 * disagree about what a reference means.
 */
export function matchesContainerIdentity(
  identity: { id: string; name?: string },
  key: string,
  wanted: string,
): boolean {
  const target = wanted.trim();
  if (!target) return false;
  const normalized = normalizeSegment(target);
  if (key === normalized) return true;
  if (identity.name && normalizeSegment(identity.name) === normalized) return true;

  const id = target.toLowerCase();
  return id.length >= MIN_ID_PREFIX && identity.id.toLowerCase().startsWith(id);
}

/**
 * The shortest id prefix a configured reference may use. Six hex characters
 * is short enough to copy from `docker ps` and long enough not to match a
 * container the operator did not mean.
 */
export const MIN_ID_PREFIX = 6;
