import type { AuthOptions, TlsOptions } from './client';

export interface InstanceConfig {
  name: string;
  enabled: boolean;
  baseUrl: string;
  auth: AuthOptions;
  tls: TlsOptions;
  timeoutMs: number;
  environment: { id: number | null; name: string };
}

/**
 * How much of Docker's state becomes boat data.
 *
 * Not a boolean, because the two useful answers are far apart: a small boat
 * server wants to know that everything is up without carrying an image name and
 * a container id for every container through its delta stream and its logs,
 * while a workshop machine wants the lot.
 *
 * - `off`    — publish nothing; the REST facade and the panel still work.
 * - `health` — instance reachability, container counts, and each container's
 *              state and health. Enough for a dashboard and the watchdog.
 * - `full`   — the above plus image, name and id per container.
 */
export type TelemetryLevel = 'off' | 'health' | 'full';

export const TELEMETRY_LEVELS: readonly TelemetryLevel[] = ['off', 'health', 'full'];

export interface PluginConfig {
  instances: InstanceConfig[];
  telemetry: {
    level: TelemetryLevel;
    intervalSeconds: number;
    pathPrefix: string;
  };
  control: {
    allowPutControl: boolean;
    allowDestructive: boolean;
    allowSelfManagement: boolean;
    watchdog: { instance: string; container: string }[];
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Instance names become Signal K path segments, so keep them path-safe. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const PLUGIN_SCHEMA = {
  type: 'object',
  properties: {
    instances: {
      type: 'array',
      title: 'Portainer servers',
      description:
        'One entry per Portainer. Add a second one to manage a shore server from the same panel.',
      items: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: {
            type: 'string',
            title: 'Name',
            default: 'local',
            description:
              'Letters, digits, underscore or hyphen. Renaming it moves this server’s Signal K paths.',
          },
          enabled: { type: 'boolean', title: 'Enabled', default: true },
          url: {
            type: 'string',
            title: 'Portainer address',
            // Deliberately empty rather than a plausible-looking
            // https://localhost:9443. The admin UI fills a default into a
            // field a saved configuration does not have, and a configuration
            // written before this was one field has no address to fill it
            // from — so a default here would quietly re-point an operator's
            // working instance at localhost the next time they pressed Save.
            default: '',
            description:
              'Scheme, host and port, e.g. https://localhost:9443, http://192.168.1.10:9000, or https://portainer.example.com behind a proxy. A path only if Portainer sits behind a path-prefixing one.',
          },
          authMode: {
            type: 'string',
            title: 'Sign in with',
            enum: ['apiKey', 'userPass'],
            enumNames: ['API access token', 'Username and password'],
            default: 'apiKey',
          },
          apiKey: {
            type: 'string',
            title: 'API access token',
            format: 'password',
            default: '',
            description: 'Portainer → My account → Access tokens. Starts with ptr_.',
          },
          username: { type: 'string', title: 'Username', default: '' },
          password: { type: 'string', title: 'Password', format: 'password', default: '' },
          advanced: {
            type: 'object',
            title: 'Advanced',
            description:
              'Only for a self-signed certificate, a slow link, or a Portainer reached by IP.',
            properties: {
              caCert: {
                type: 'string',
                title: 'CA certificate (PEM)',
                default: '',
                description:
                  'Portainer’s own certificate is self-signed; pasting its CA here is the way to trust it.',
              },
              rejectUnauthorized: {
                type: 'boolean',
                title: 'Verify TLS certificate',
                default: true,
                description: 'Turn off only for a certificate you cannot supply a CA for.',
              },
              servername: {
                type: 'string',
                title: 'TLS servername override',
                default: '',
                description: 'Set when connecting by IP to a certificate issued for a hostname.',
              },
              timeoutMs: { type: 'number', title: 'Request timeout (ms)', default: 10000 },
            },
          },
          // Written by the panel when an environment is chosen there, and
          // hidden from this form by the UI schema below: an id typed here by
          // hand is how an operator ends up managing the wrong Docker host.
          environmentId: { type: 'number', title: 'Environment id' },
          environmentName: { type: 'string', title: 'Environment name', default: '' },
        },
      },
    },
    telemetry: {
      type: 'object',
      title: 'Signal K telemetry',
      properties: {
        level: {
          type: 'string',
          title: 'Publish deltas',
          enum: ['off', 'health', 'full'],
          enumNames: [
            'Off — no Signal K paths',
            'Health — status, counts, container state and health',
            'Full — also image, name and id per container',
          ],
          default: 'health',
        },
        intervalSeconds: { type: 'number', title: 'Poll interval (s)', default: 30 },
        pathPrefix: { type: 'string', title: 'Path prefix', default: 'system.docker' },
      },
    },
    control: {
      type: 'object',
      title: 'Control',
      properties: {
        allowPutControl: { type: 'boolean', title: 'Allow Signal K PUT control', default: true },
        allowDestructive: {
          type: 'boolean',
          title: 'Allow destructive operations',
          default: false,
          description: 'Remove containers and volumes, delete stacks, prune.',
        },
        allowSelfManagement: {
          type: 'boolean',
          title: 'Allow managing the Signal K container itself',
          default: false,
          description: 'Stopping it stops this plugin. Off unless you mean it.',
        },
        watchdog: {
          type: 'array',
          title: 'Watchdog',
          description:
            'Containers whose absence raises a Signal K alarm. Nothing is published unless something is listed here.',
          items: {
            type: 'object',
            required: ['container'],
            properties: {
              container: {
                type: 'string',
                title: 'Container',
                default: '',
                description: 'Its name, or the key it publishes under.',
              },
              instance: {
                type: 'string',
                title: 'Portainer server',
                default: '',
                description: 'Leave empty for the first enabled one.',
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * How the admin UI renders the schema above.
 *
 * Two jobs. The environment fields are hidden: the panel writes them when an
 * environment is chosen from its Environments tab, and an id typed in by hand
 * is how an operator ends up managing the wrong Docker host. And the fields
 * that matter come first, so what an operator has to fill in to connect is not
 * buried among the ones they almost never touch.
 */
export const PLUGIN_UI_SCHEMA = {
  instances: {
    items: {
      'ui:order': ['name', 'enabled', 'url', 'authMode', 'apiKey', 'username', 'password', '*'],
      environmentId: { 'ui:widget': 'hidden' },
      environmentName: { 'ui:widget': 'hidden' },
      advanced: {
        // A PEM is a dozen lines; a single-line input makes it unreadable.
        caCert: { 'ui:widget': 'textarea' },
      },
    },
  },
} as const;

/** The settings an operator rarely touches, kept out of the way in the form. */
interface RawAdvanced {
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
  caCert?: string;
  servername?: string;
}

/**
 * An instance as the admin UI hands it back.
 *
 * The address is one field now — `url` — and the rarely-used settings live
 * under `advanced`. The fields either replaced are still read, so a
 * configuration written by an earlier build keeps connecting to the same
 * Portainer instead of coming up empty and having to be typed again.
 */
interface RawInstance extends RawAdvanced {
  name?: string;
  enabled?: boolean;
  url?: string;
  advanced?: RawAdvanced;
  authMode?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  environmentId?: number | null;
  environmentName?: string;
  /** @deprecated superseded by `url`. */
  protocol?: string;
  /** @deprecated superseded by `url`. */
  host?: string;
  /** @deprecated superseded by `url`. */
  port?: number;
  /** @deprecated superseded by `url`. */
  basePath?: string;
}

export interface RawConfig {
  instances?: RawInstance[];
  telemetry?: RawTelemetry;
  control?: Omit<Partial<PluginConfig['control']>, 'watchdog'> & {
    watchdog?: { instance?: string; container?: string }[];
  };
}

/**
 * The telemetry block as it arrives from the admin UI. `level` is typed loosely
 * because the UI can hand back anything, and `enabled` is the boolean this
 * setting used to be, kept readable for migration.
 */
interface RawTelemetry {
  level?: string;
  /** @deprecated superseded by `level`; still read so old options keep working. */
  enabled?: boolean;
  intervalSeconds?: number;
  pathPrefix?: string;
}

/** Validates admin-UI input into the shape the rest of the plugin relies on. */
export function normalizeConfig(raw: RawConfig | undefined): PluginConfig {
  const rawInstances = raw?.instances ?? [];
  if (rawInstances.length === 0) {
    throw new ConfigError('No Portainer instance configured — add one under Portainer instances');
  }

  const seen = new Set<string>();
  const instances = rawInstances.map((entry, index) => normalizeInstance(entry, index, seen));

  if (!instances.some((instance) => instance.enabled)) {
    throw new ConfigError('Every configured Portainer instance is disabled');
  }

  const telemetry = {
    level: telemetryLevel(raw?.telemetry),
    intervalSeconds: pollInterval(raw?.telemetry?.intervalSeconds),
    pathPrefix: (raw?.telemetry?.pathPrefix || 'system.docker').replace(/\.+$/, ''),
  };

  const watchdog = (raw?.control?.watchdog ?? [])
    .filter((entry) => entry.container)
    .map((entry) => {
      const instance = entry.instance || (instances.find((i) => i.enabled)?.name ?? 'local');
      // Checked rather than trusted. The poller only evaluates instances that
      // exist and are enabled, so a typo here does not fail — it silently
      // watches nothing, and the operator discovers it the night the container
      // they were watching dies and no alarm sounds.
      if (!instances.some((candidate) => candidate.enabled && candidate.name === instance)) {
        throw new ConfigError(
          `Watchdog entry for "${entry.container}" names instance "${instance}", which is not a configured, enabled instance`,
        );
      }
      return { instance, container: entry.container as string };
    });

  return {
    instances,
    telemetry,
    control: {
      allowPutControl: raw?.control?.allowPutControl ?? true,
      allowDestructive: raw?.control?.allowDestructive ?? false,
      allowSelfManagement: raw?.control?.allowSelfManagement ?? false,
      watchdog,
    },
  };
}

/**
 * Reads the publishing level, accepting the boolean this setting used to be so
 * a configuration saved by an earlier build keeps working rather than silently
 * reverting to the default.
 */
function telemetryLevel(raw: RawTelemetry | undefined): TelemetryLevel {
  const level = raw?.level;
  if (typeof level === 'string' && (TELEMETRY_LEVELS as string[]).includes(level)) {
    return level as TelemetryLevel;
  }
  if (typeof raw?.enabled === 'boolean') return raw.enabled ? 'full' : 'off';
  return 'health';
}

/**
 * The poll interval, floored and capped.
 *
 * A floor alone is not enough. `Math.max(5, "abc")` is NaN, and `setInterval`
 * with NaN fires every millisecond; anything past ~24.8 days overflows Node's
 * 32-bit timer and does the same. Either way the plugin becomes a busy loop on
 * a Raspberry Pi, and nothing says why.
 */
function pollInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30;
  return Math.min(3600, Math.max(5, Math.floor(value)));
}

function normalizeInstance(entry: RawInstance, index: number, seen: Set<string>): InstanceConfig {
  const label = entry.name || `instance ${index + 1}`;

  const name = (entry.name || '').trim();
  if (!name) throw new ConfigError(`Instance ${index + 1} has no name`);
  if (!NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `Instance name "${name}" is not path-safe — use letters, digits, underscore or hyphen`,
    );
  }
  if (seen.has(name.toLowerCase())) {
    throw new ConfigError(`Duplicate instance name "${name}" — names must be unique`);
  }
  seen.add(name.toLowerCase());

  const baseUrl = baseUrlOf(entry, label);

  // `advanced` wins where both are present; the flat ones are what an older
  // configuration wrote.
  const advanced: RawAdvanced = { ...pickAdvanced(entry), ...(entry.advanced ?? {}) };

  const timeoutMs = advanced.timeoutMs ?? 10_000;
  // A ceiling as well as a floor. `AbortSignal.timeout` is bounded by the same
  // 32-bit timer everything else in Node is, and a value past it aborts almost
  // immediately — so an operator typing a very large number would get a plugin
  // where every request fails at once, reported as a timeout, which is true
  // and utterly misleading.
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new ConfigError(`Instance "${label}" needs a timeout between 1000 and 120000 ms`);
  }

  const auth = normalizeAuth(entry, label);

  const tls: TlsOptions = {};
  if (advanced.rejectUnauthorized === false) tls.rejectUnauthorized = false;
  if (advanced.caCert) tls.ca = advanced.caCert;
  if (advanced.servername) tls.servername = advanced.servername;

  return {
    name,
    enabled: entry.enabled ?? true,
    baseUrl,
    auth,
    tls,
    timeoutMs,
    environment: {
      id:
        entry.environmentId === undefined || entry.environmentId === null
          ? null
          : entry.environmentId,
      name: entry.environmentName || '',
    },
  };
}

/** The advanced settings an older configuration wrote as flat fields. */
function pickAdvanced(entry: RawInstance): RawAdvanced {
  const advanced: RawAdvanced = {};
  if (entry.timeoutMs !== undefined) advanced.timeoutMs = entry.timeoutMs;
  if (entry.rejectUnauthorized !== undefined)
    advanced.rejectUnauthorized = entry.rejectUnauthorized;
  if (entry.caCert) advanced.caCert = entry.caCert;
  if (entry.servername) advanced.servername = entry.servername;
  return advanced;
}

/**
 * Where this instance's Portainer answers.
 *
 * One address rather than the four fields — protocol, host, port, base path —
 * this used to ask for separately, since one address is how everybody already
 * writes it. A port left out means the scheme's own, as it does in a browser,
 * so a Portainer behind a reverse proxy on 443 needs no port typed at all.
 */
function baseUrlOf(entry: RawInstance, label: string): string {
  const raw = (entry.url ?? '').trim();
  if (!raw) return legacyBaseUrl(entry, label);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`Instance "${label}" has an address that is not a URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`Instance "${label}" address must start with https:// or http://`);
  }
  // `origin` rather than the parts: it keeps an IPv6 host's brackets and drops
  // a port that is the scheme's default anyway.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** The address as an earlier build's configuration spelled it. */
function legacyBaseUrl(entry: RawInstance, label: string): string {
  const host = (entry.host ?? '').trim();
  if (!host) {
    throw new ConfigError(
      `Instance "${label}" has no address — set it to where Portainer answers, e.g. https://localhost:9443`,
    );
  }

  const protocol = entry.protocol === 'http' ? 'http' : 'https';
  const port = entry.port ?? (protocol === 'https' ? 9443 : 9000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Instance "${label}" has an invalid port: ${entry.port}`);
  }

  const basePath = (entry.basePath || '').replace(/\/+$/, '');
  if (basePath && !basePath.startsWith('/')) {
    throw new ConfigError(`Instance "${label}" base path must start with "/"`);
  }

  return `${protocol}://${host}:${port}${basePath}`;
}

function normalizeAuth(entry: RawInstance, label: string): AuthOptions {
  if (entry.authMode === 'userPass') {
    if (!entry.username || !entry.password) {
      throw new ConfigError(`Instance "${label}" uses username/password but one of them is empty`);
    }
    return { mode: 'userPass', username: entry.username, password: entry.password };
  }
  if (!entry.apiKey) {
    throw new ConfigError(
      `Instance "${label}" has no API token — create one under Portainer → My account → Access tokens`,
    );
  }
  return { mode: 'apiKey', apiKey: entry.apiKey };
}
