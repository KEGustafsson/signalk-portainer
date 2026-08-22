import { readFileSync, existsSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';

/**
 * Identifying the container this plugin is running in.
 *
 * This exists for one reason: stopping that container stops Signal K, and with
 * it the plugin issuing the request. The operator gets no error, no UI, and no
 * way back except a shell on the host.
 */

export type SelfSource = 'cgroup' | 'mountinfo' | 'hostname' | 'none';

export interface SelfContainer {
  /** True when this process appears to be inside a container at all. */
  inContainer: boolean;
  /** Full 64-hex id when it could be determined. */
  id?: string;
  /** 12-hex prefix, which is what Docker shows and what hostnames default to. */
  shortId?: string;
  /** Where the answer came from, for diagnostics. */
  source: SelfSource;
  /**
   * True only when an id is known. When false while inContainer is true, the
   * plugin cannot recognise itself and self-protection is inactive — the
   * plugin surfaces that rather than pretending to be safe.
   */
  identified: boolean;
}

/** Injectable so the parsers can be tested against real-world fixtures. */
export interface SelfSources {
  readFile: (path: string) => string | undefined;
  fileExists: (path: string) => boolean;
  hostname: () => string;
}

const CGROUP_PATTERNS: readonly RegExp[] = [
  // cgroup v1, cgroupfs driver: 12:pids:/docker/<64hex>
  /\/docker[/-]([0-9a-f]{64})/,
  // systemd driver: .../system.slice/docker-<64hex>.scope
  /docker-([0-9a-f]{64})\.scope/,
  // containerd / CRI, as used by Kubernetes
  /cri-containerd[-:]([0-9a-f]{64})/,
  // kubepods: .../pod<uuid>/<64hex>
  /\/kubepods\/.*\/([0-9a-f]{64})/,
];

// Docker bind-mounts /etc/hostname, /etc/hosts and /etc/resolv.conf from
// /var/lib/docker/containers/<id>/, which survives cgroup v2 hiding the id.
const MOUNTINFO_PATTERN = /\/containers\/([0-9a-f]{64})\//;

const HOSTNAME_PATTERN = /^[0-9a-f]{12}$/;

const defaultSources: SelfSources = {
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  fileExists: (path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
  hostname: () => {
    try {
      return osHostname();
    } catch {
      return '';
    }
  },
};

/**
 * Best-effort identification of the current container.
 *
 * cgroup v2 commonly reports just "0::/" with no id, so mountinfo is tried
 * next, and the hostname last — Docker defaults it to the short id, but only
 * when the operator has not overridden it, so it is used only once something
 * else has established that we are in a container.
 */
export function detectSelfContainer(overrides: Partial<SelfSources> = {}): SelfContainer {
  const sources: SelfSources = { ...defaultSources, ...overrides };

  const cgroup = sources.readFile('/proc/self/cgroup');
  const mountinfo = sources.readFile('/proc/self/mountinfo');
  const dockerEnv = sources.fileExists('/.dockerenv');

  const fromCgroup = matchFirst(cgroup, CGROUP_PATTERNS);
  if (fromCgroup) return identified(fromCgroup, 'cgroup');

  const fromMountinfo = matchFirst(mountinfo, [MOUNTINFO_PATTERN]);
  if (fromMountinfo) return identified(fromMountinfo, 'mountinfo');

  // Nothing carried an id. Decide whether we are containerised at all.
  const containerised = dockerEnv || looksContainerised(cgroup, mountinfo);
  if (!containerised) {
    return { inContainer: false, source: 'none', identified: false };
  }

  const host = sources.hostname().trim().toLowerCase();
  if (HOSTNAME_PATTERN.test(host)) {
    return { inContainer: true, shortId: host, source: 'hostname', identified: true };
  }

  // In a container but unidentifiable — usually a custom --hostname under
  // cgroup v2 with no bind mounts. Self-protection cannot work here.
  return { inContainer: true, source: 'none', identified: false };
}

function identified(id: string, source: SelfSource): SelfContainer {
  return { inContainer: true, id, shortId: id.slice(0, 12), source, identified: true };
}

function matchFirst(text: string | undefined, patterns: readonly RegExp[]): string | undefined {
  if (!text) return undefined;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** cgroup v2 in a container still shows container-ish mounts even without an id. */
function looksContainerised(cgroup: string | undefined, mountinfo: string | undefined): boolean {
  if (cgroup && /\/(docker|kubepods|containerd)\b/.test(cgroup)) return true;
  return Boolean(mountinfo && /\/var\/lib\/(docker|containerd)\//.test(mountinfo));
}

/**
 * Whether a Docker container id refers to this process's own container.
 *
 * Docker accepts any unambiguous id prefix, so a request may carry a short id
 * while we hold the full one, or the reverse. Comparison is prefix-based in
 * both directions, with a floor of 12 characters so a coincidentally short
 * input cannot match everything.
 */
export function isSelfContainer(self: SelfContainer, containerId: string): boolean {
  if (!self.identified) return false;
  const candidate = containerId.trim().toLowerCase();
  if (candidate.length < 12) return false;

  const known = self.id ?? self.shortId;
  if (!known) return false;

  return known.startsWith(candidate) || candidate.startsWith(known);
}
