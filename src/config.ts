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
      title: 'Portainer instances',
      description:
        'One entry per Portainer server. The name is used in the UI and as a Signal K path segment.',
      items: {
        type: 'object',
        required: ['name', 'host'],
        properties: {
          name: {
            type: 'string',
            title: 'Name',
            default: 'local',
            description: 'Unique, path-safe. Renaming it moves this instance’s Signal K paths.',
          },
          enabled: { type: 'boolean', title: 'Enabled', default: true },
          protocol: {
            type: 'string',
            title: 'Protocol',
            enum: ['https', 'http'],
            default: 'https',
          },
          host: { type: 'string', title: 'Host', default: 'localhost' },
          port: { type: 'number', title: 'Port', default: 9443 },
          basePath: {
            type: 'string',
            title: 'Base path',
            default: '',
            description: 'Only if Portainer sits behind a path-prefixing proxy.',
          },
          timeoutMs: { type: 'number', title: 'Request timeout (ms)', default: 10000 },
          rejectUnauthorized: {
            type: 'boolean',
            title: 'Verify TLS certificate',
            default: true,
            description: 'Turn off only for a self-signed certificate you cannot supply a CA for.',
          },
          caCert: {
            type: 'string',
            title: 'CA certificate (PEM)',
            default: '',
            description: 'Preferred over disabling verification for self-signed certificates.',
          },
          servername: {
            type: 'string',
            title: 'TLS servername override',
            default: '',
            description: 'Set when connecting by IP to a certificate issued for a hostname.',
          },
          authMode: {
            type: 'string',
            title: 'Authentication',
            enum: ['apiKey', 'userPass'],
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
          environmentId: {
            type: 'number',
            title: 'Environment id',
            description: 'Leave empty to auto-select when Portainer has exactly one environment.',
          },
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
                title: 'Instance',
                default: '',
                description: 'Leave empty for the first enabled instance.',
              },
            },
          },
        },
      },
    },
  },
} as const;

interface RawInstance {
  name?: string;
  enabled?: boolean;
  protocol?: string;
  host?: string;
  port?: number;
  basePath?: string;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
  caCert?: string;
  servername?: string;
  authMode?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  environmentId?: number | null;
  environmentName?: string;
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

  const host = (entry.host || '').trim();
  if (!host) throw new ConfigError(`Instance "${label}" has no host`);

  const protocol = entry.protocol === 'http' ? 'http' : 'https';
  const port = entry.port ?? (protocol === 'https' ? 9443 : 9000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Instance "${label}" has an invalid port: ${entry.port}`);
  }

  const timeoutMs = entry.timeoutMs ?? 10_000;
  // A ceiling as well as a floor. `AbortSignal.timeout` is bounded by the same
  // 32-bit timer everything else in Node is, and a value past it aborts almost
  // immediately — so an operator typing a very large number would get a plugin
  // where every request fails at once, reported as a timeout, which is true
  // and utterly misleading.
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new ConfigError(`Instance "${label}" needs a timeout between 1000 and 120000 ms`);
  }

  const basePath = (entry.basePath || '').replace(/\/+$/, '');
  if (basePath && !basePath.startsWith('/')) {
    throw new ConfigError(`Instance "${label}" base path must start with "/"`);
  }

  const auth = normalizeAuth(entry, label);

  const tls: TlsOptions = {};
  if (entry.rejectUnauthorized === false) tls.rejectUnauthorized = false;
  if (entry.caCert) tls.ca = entry.caCert;
  if (entry.servername) tls.servername = entry.servername;

  return {
    name,
    enabled: entry.enabled ?? true,
    baseUrl: `${protocol}://${host}:${port}${basePath}`,
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
