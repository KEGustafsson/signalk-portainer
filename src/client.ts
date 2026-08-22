import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { TtlCache, TTL } from './cache';
import { PortainerError, type AuthMode } from './errors';
import { redactValue } from './redact';
import {
  EDGE_ENVIRONMENT_TYPES,
  type Capabilities,
  type DockerContainer,
  type DockerContainerInspect,
  type DockerDiskUsage,
  type DockerImage,
  type DockerInfo,
  type DockerNetwork,
  type DockerNode,
  type DockerService,
  type DockerVolume,
  type DockerVolumeList,
  type Environment,
  type EnvironmentHealth,
  type PortainerStatus,
  type Stack,
} from './types';

/**
 * Read-only slice of the Docker Engine API, reached through Portainer's docker
 * proxy. The environment id is already bound to the client, so no call site
 * passes one.
 */
export interface DockerApi {
  info(): Promise<DockerInfo>;
  listContainers(all?: boolean): Promise<DockerContainer[]>;
  inspectContainer(id: string): Promise<DockerContainerInspect>;
  listImages(): Promise<DockerImage[]>;
  listVolumes(): Promise<DockerVolume[]>;
  listNetworks(): Promise<DockerNetwork[]>;
  diskUsage(): Promise<DockerDiskUsage>;
  /** Swarm only — callers must check capabilities().swarm first. */
  listServices(): Promise<DockerService[]>;
  /** Swarm only — callers must check capabilities().swarm first. */
  listNodes(): Promise<DockerNode[]>;

  // ── lifecycle ───────────────────────────────────────────────────────────
  // Each mutation drops the cached container list, so the next read reflects
  // the change instead of serving a snapshot from before it.

  startContainer(id: string): Promise<void>;
  /** `timeoutSeconds` is how long Docker waits before SIGKILL. */
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  restartContainer(id: string, timeoutSeconds?: number): Promise<void>;
  killContainer(id: string, signal?: string): Promise<void>;
  removeContainer(id: string, opts?: { force?: boolean; removeVolumes?: boolean }): Promise<void>;
}

/**
 * Cache keys a container mutation can change. Anything not listed describes the
 * environment itself — its id, its capabilities — and survives, so starting a
 * container does not cost an environment re-resolution.
 */
const CONTAINER_VOLATILE_KEYS = [
  'containers:true',
  'containers:false',
  'stacks',
  'volumes',
  'df',
  'services',
] as const;

/** A JWT is valid for ~8h; renew at 7h so a long poll never straddles expiry. */
const JWT_MAX_AGE_MS = 7 * 60 * 60 * 1000;

/** Edge agents are "up" while they checked in within 2 x interval + 20s. */
const EDGE_GRACE_SECONDS = 20;
const EDGE_DEFAULT_INTERVAL_SECONDS = 60;

export type AuthOptions =
  { mode: 'apiKey'; apiKey: string } | { mode: 'userPass'; username: string; password: string };

export interface TlsOptions {
  ca?: string;
  rejectUnauthorized?: boolean;
  servername?: string;
}

export interface EnvironmentSelector {
  id?: number | null;
  name?: string;
}

export interface PortainerClientOptions {
  baseUrl: string;
  auth: AuthOptions;
  tls?: TlsOptions;
  timeoutMs?: number;
  environment?: EnvironmentSelector;
  /** Test seam: inject an undici MockAgent instead of a real connection. */
  dispatcher?: Dispatcher;
  log?: (message: string) => void;
}

interface RawInit {
  headers?: Record<string, string>;
  json?: unknown;
  timeoutMs?: number;
}

/**
 * One client per configured Portainer instance. The environment id is resolved
 * once and bound to the instance, so no call site can pass the wrong one.
 */
export class PortainerClient {
  private readonly baseUrl: string;
  private readonly auth: AuthOptions;
  private readonly timeoutMs: number;
  private readonly selector: EnvironmentSelector;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly ownsDispatcher: boolean;
  private readonly cache = new TtlCache();
  private readonly log: (message: string) => void;
  private jwt: { token: string; issuedAt: number } | undefined;
  private jwtInFlight: Promise<string> | undefined;

  /** Read-only Docker surface; see {@link DockerApi}. */
  readonly docker: DockerApi;

  constructor(options: PortainerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.auth = options.auth;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.selector = options.environment ?? {};
    this.log = options.log ?? (() => {});

    if (options.dispatcher) {
      this.dispatcher = options.dispatcher;
      this.ownsDispatcher = false;
    } else if (
      options.tls &&
      (options.tls.ca || options.tls.rejectUnauthorized === false || options.tls.servername)
    ) {
      this.dispatcher = new Agent({
        connect: {
          ca: options.tls.ca || undefined,
          rejectUnauthorized: options.tls.rejectUnauthorized !== false,
          servername: options.tls.servername || undefined,
        },
      });
      this.ownsDispatcher = true;
    } else {
      this.dispatcher = undefined;
      this.ownsDispatcher = false;
    }

    this.docker = this.buildDockerApi();
  }

  private buildDockerApi(): DockerApi {
    const proxied = async <T>(path: string, key: string, ttlMs: number): Promise<T> =>
      this.cache.get(key, ttlMs, async () =>
        this.json<T>('GET', `${await this.dockerBase()}${path}`),
      );

    const encode = (id: string): string => encodeURIComponent(id);
    const seconds = (value?: number): string =>
      value === undefined ? '' : `?t=${Math.max(0, Math.floor(value))}`;

    /**
     * Runs a state-changing proxy call and drops the cached reads it can
     * change, so the UI's next poll shows the result rather than a pre-change
     * snapshot.
     *
     * Only those keys: the resolved environment, its capabilities and the
     * environment list describe the target rather than its contents, and
     * dropping them would make every button press pay for a fresh
     * GET /api/endpoints.
     */
    const mutate = async (method: string, path: string): Promise<void> => {
      const response = await this.send(method, `${await this.dockerBase()}${path}`, {}, true);
      // Docker answers 204 for these; the body is drained so the connection is
      // released rather than left for the collector.
      await response.body?.cancel().catch(() => undefined);
      this.cache.invalidate(CONTAINER_VOLATILE_KEYS);
    };

    return {
      info: () => this.dockerInfo(),

      listContainers: (all = false) =>
        proxied<DockerContainer[]>(
          `/containers/json${all ? '?all=true' : ''}`,
          `containers:${all}`,
          TTL.containers,
        ),

      // Deliberately uncached: an inspect is requested when someone opens a
      // container, and a stale answer there is worse than an extra call.
      inspectContainer: async (id: string) =>
        this.json<DockerContainerInspect>(
          'GET',
          `${await this.dockerBase()}/containers/${encodeURIComponent(id)}/json`,
        ),

      listImages: () => proxied<DockerImage[]>('/images/json', 'images', TTL.containers),

      listVolumes: async () => {
        const list = await proxied<DockerVolumeList>('/volumes', 'volumes', TTL.containers);
        // Docker returns null rather than [] when there are no volumes.
        return list.Volumes ?? [];
      },

      listNetworks: () => proxied<DockerNetwork[]>('/networks', 'networks', TTL.containers),

      diskUsage: () => proxied<DockerDiskUsage>('/system/df', 'df', TTL.containers),

      listServices: () => proxied<DockerService[]>('/services', 'services', TTL.containers),

      listNodes: () => proxied<DockerNode[]>('/nodes', 'nodes', TTL.containers),

      startContainer: (id) => mutate('POST', `/containers/${encode(id)}/start`),

      stopContainer: (id, timeoutSeconds) =>
        mutate('POST', `/containers/${encode(id)}/stop${seconds(timeoutSeconds)}`),

      restartContainer: (id, timeoutSeconds) =>
        mutate('POST', `/containers/${encode(id)}/restart${seconds(timeoutSeconds)}`),

      killContainer: (id, signal) =>
        mutate(
          'POST',
          `/containers/${encode(id)}/kill${signal ? `?signal=${encodeURIComponent(signal)}` : ''}`,
        ),

      removeContainer: (id, opts = {}) =>
        mutate(
          'DELETE',
          // v defaults to false: removing a container's volumes destroys data
          // and must never be implied by removing the container.
          `/containers/${encode(id)}?force=${opts.force ? 'true' : 'false'}&v=${
            opts.removeVolumes ? 'true' : 'false'
          }`,
        ),
    };
  }

  get authMode(): AuthMode {
    return this.auth.mode;
  }

  /** Low-level escape hatch. Everything else in this class goes through it. */
  async raw(method: string, path: string, init: RawInit = {}): Promise<Response> {
    return this.send(method, path, init, true);
  }

  private async send(
    method: string,
    path: string,
    init: RawInit,
    mayRetryAuth: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(init.headers ?? {}),
      ...(await this.authHeaders()),
    };
    if (init.json !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = (await undiciFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      })) as unknown as Response;
    } catch (cause) {
      throw PortainerError.fromTransport(cause, method, path, this.baseUrl);
    }

    // A rejected JWT is renewable; a rejected API key is not.
    if (res.status === 401 && mayRetryAuth && this.auth.mode === 'userPass') {
      this.jwt = undefined;
      // Release the connection before the retry rather than leaving the body
      // dangling for the garbage collector.
      await res.body?.cancel().catch(() => undefined);
      this.log('Portainer rejected the cached JWT, re-authenticating');
      return this.send(method, path, init, false);
    }

    if (!res.ok) throw await PortainerError.fromResponse(res, method, path, this.auth.mode);
    return res;
  }

  private async json<T>(method: string, path: string, init: RawInit = {}): Promise<T> {
    const res = await this.send(method, path, init, true);
    return (await res.json()) as T;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.auth.mode === 'apiKey') return { 'x-api-key': this.auth.apiKey };
    return { authorization: `Bearer ${await this.jwtToken()}` };
  }

  private async jwtToken(): Promise<string> {
    if (this.auth.mode !== 'userPass') throw new Error('jwtToken called outside userPass mode');
    if (this.jwt && Date.now() - this.jwt.issuedAt < JWT_MAX_AGE_MS) return this.jwt.token;

    // Concurrent callers share one /api/auth round trip: without this, a burst
    // of parallel requests authenticates once per request and the last response
    // wins the cache slot.
    if (!this.jwtInFlight) {
      this.jwtInFlight = this.authenticate().finally(() => {
        this.jwtInFlight = undefined;
      });
    }
    return this.jwtInFlight;
  }

  private async authenticate(): Promise<string> {
    if (this.auth.mode !== 'userPass') throw new Error('authenticate called outside userPass mode');

    // Deliberately not via send(): the auth call must carry no auth header.
    let res: Response;
    try {
      res = (await undiciFetch(`${this.baseUrl}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ Username: this.auth.username, Password: this.auth.password }),
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      })) as unknown as Response;
    } catch (cause) {
      throw PortainerError.fromTransport(cause, 'POST', '/api/auth', this.baseUrl);
    }

    if (!res.ok) throw await PortainerError.fromResponse(res, 'POST', '/api/auth', this.auth.mode);

    const payload = (await res.json()) as { jwt?: string };
    if (!payload.jwt) {
      throw new PortainerError({
        status: 0,
        method: 'POST',
        path: '/api/auth',
        message: 'Portainer returned no jwt field',
        hint: 'the response did not look like a Portainer auth response — check the base URL',
      });
    }
    this.jwt = { token: payload.jwt, issuedAt: Date.now() };
    return payload.jwt;
  }

  // ---------------------------------------------------------------- typed API

  async systemStatus(): Promise<PortainerStatus> {
    return this.json<PortainerStatus>('GET', '/api/system/status');
  }

  async listEnvironments(opts: { excludeSnapshots?: boolean } = {}): Promise<Environment[]> {
    const query = opts.excludeSnapshots === false ? '' : '?excludeSnapshots=true';
    return this.cache.get(`environments${query}`, TTL.environments, () =>
      this.json<Environment[]>('GET', `/api/endpoints${query}`),
    );
  }

  /**
   * Resolves the one environment this client operates on. Never guesses: an
   * ambiguous configuration is an error, not a coin flip.
   */
  async environment(): Promise<Environment> {
    return this.cache.get('environment', TTL.environments, async () => {
      const environments = await this.listEnvironments({ excludeSnapshots: true });

      if (this.selector.id !== undefined && this.selector.id !== null) {
        const match = environments.find((env) => env.Id === this.selector.id);
        if (match) return match;
        throw new PortainerError({
          status: 404,
          method: 'GET',
          path: '/api/endpoints',
          message: `Portainer environment id ${this.selector.id} not found`,
          hint: `available: ${describe(environments)}. Ids are assigned in creation order, not by name`,
        });
      }

      if (this.selector.name) {
        const wanted = this.selector.name.toLowerCase();
        const match = environments.find((env) => env.Name.toLowerCase() === wanted);
        if (match) return match;
        throw new PortainerError({
          status: 404,
          method: 'GET',
          path: '/api/endpoints',
          message: `Portainer environment named "${this.selector.name}" not found`,
          hint: `available: ${describe(environments)}`,
        });
      }

      const only = environments[0];
      if (environments.length === 1 && only) return only;

      if (environments.length === 0) {
        throw new PortainerError({
          status: 404,
          method: 'GET',
          path: '/api/endpoints',
          message: 'Portainer reports no environments',
          hint: 'either none is configured, or this credential is not authorized for any',
        });
      }

      throw new PortainerError({
        status: 400,
        method: 'GET',
        path: '/api/endpoints',
        message: 'Portainer has several environments and none is configured',
        hint: `set environment.id or environment.name — available: ${describe(environments)}`,
      });
    });
  }

  async environmentId(): Promise<number> {
    return (await this.environment()).Id;
  }

  /**
   * Swarm support is probed, never configured: docker/info already reports it
   * and yields the SwarmID that swarm stack creation needs.
   */
  async capabilities(): Promise<Capabilities> {
    return this.cache.get('capabilities', TTL.dockerInfo, async () => {
      const [info, status] = await Promise.all([
        this.dockerInfo(),
        this.systemStatus().catch((cause: unknown) => {
          // Swallowed so a missing version never fails the probe, but logged so
          // an auth or TLS failure here is diagnosable rather than invisible.
          this.log(
            `system status probe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          return undefined;
        }),
      ]);
      const swarm = info.Swarm?.LocalNodeState === 'active';
      const result: Capabilities = { swarm };
      const swarmId = info.Swarm?.Cluster?.ID;
      if (swarm && swarmId) result.swarmId = swarmId;
      if (info.ServerVersion) result.dockerVersion = info.ServerVersion;
      if (status?.Version) result.portainerVersion = status.Version;
      return result;
    });
  }

  /**
   * Stacks belonging to this client's environment. Portainer returns every
   * stack it knows about, so the filtering happens here.
   */
  async listStacks(): Promise<Stack[]> {
    const environmentId = await this.environmentId();
    const all = await this.cache.get('stacks', TTL.stacks, () =>
      this.json<Stack[]>('GET', '/api/stacks'),
    );
    return all.filter((stack) => stack.EndpointId === environmentId);
  }

  /**
   * The compose or manifest file for a stack, as text.
   *
   * The id is resolved against this environment's stacks first. Portainer would
   * happily serve the file for any stack the configured credential can reach,
   * including stacks belonging to a different environment, so the ownership
   * check has to happen here rather than being left to Portainer.
   */
  async stackFile(id: number): Promise<string> {
    const stacks = await this.listStacks();
    if (!stacks.some((stack) => stack.Id === id)) {
      throw new PortainerError({
        status: 404,
        method: 'GET',
        path: `/api/stacks/${id}/file`,
        message: `Stack ${id} does not belong to this environment`,
        hint: `stacks in this environment: ${
          stacks.map((stack) => `${stack.Id}:${stack.Name}`).join(', ') || 'none'
        }`,
      });
    }
    const payload = await this.json<{ StackFileContent?: string }>('GET', `/api/stacks/${id}/file`);
    return payload.StackFileContent ?? '';
  }

  async dockerInfo(): Promise<DockerInfo> {
    return this.cache.get('docker/info', TTL.dockerInfo, async () =>
      this.json<DockerInfo>('GET', `${await this.dockerBase()}/info`),
    );
  }

  private async dockerBase(): Promise<string> {
    return `/api/endpoints/${await this.environmentId()}/docker`;
  }

  /**
   * Drops every cached read, the resolved environment included, so the next
   * call re-resolves it. Credentials and the dispatcher survive. Mutations use
   * a narrower drop; this one is for a configuration change, where the
   * environment itself may now be a different one.
   */
  invalidate(): void {
    this.cache.invalidate();
  }

  close(): void {
    if (!this.ownsDispatcher || !this.dispatcher) return;
    // close() rejecting during shutdown would otherwise surface as an unhandled
    // rejection and take the Signal K process down with it.
    this.dispatcher.close().catch((cause: unknown) => {
      this.log(
        `dispatcher close failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  }

  /** Safe to log or return: no credentials, no snapshot payloads. */
  describeSelf(): Record<string, unknown> {
    return redactValue({
      baseUrl: this.baseUrl,
      authMode: this.auth.mode,
      environment: this.selector,
      timeoutMs: this.timeoutMs,
    });
  }
}

function describe(environments: Environment[]): string {
  if (environments.length === 0) return 'none';
  return environments.map((env) => `${env.Id}:${env.Name}`).join(', ');
}

/**
 * Edge environments (types 4 and 7) do not populate Status; their health is
 * check-in recency. Direct environments ignore the check-in fields entirely.
 */
export function environmentHealth(environment: Environment, nowMs = Date.now()): EnvironmentHealth {
  if (EDGE_ENVIRONMENT_TYPES.includes(environment.Type)) {
    if (!environment.LastCheckInDate) return 'down';
    const interval =
      environment.EdgeCheckinInterval && environment.EdgeCheckinInterval > 0
        ? environment.EdgeCheckinInterval
        : EDGE_DEFAULT_INTERVAL_SECONDS;
    const ageSeconds = nowMs / 1000 - environment.LastCheckInDate;
    return ageSeconds <= 2 * interval + EDGE_GRACE_SECONDS ? 'up' : 'down';
  }
  if (environment.Status === 1) return 'up';
  if (environment.Status === 2) return 'down';
  return 'unknown';
}
