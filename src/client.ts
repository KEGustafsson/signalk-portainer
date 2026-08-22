import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { TtlCache, TTL } from './cache';
import { PortainerError, type AuthMode } from './errors';
import { redactValue } from './redact';
import {
  EDGE_ENVIRONMENT_TYPES,
  type Capabilities,
  type DockerInfo,
  type Environment,
  type EnvironmentHealth,
  type PortainerStatus,
} from './types';

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
        this.systemStatus().catch(() => undefined),
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

  async dockerInfo(): Promise<DockerInfo> {
    return this.cache.get('docker/info', TTL.dockerInfo, async () =>
      this.json<DockerInfo>('GET', `${await this.dockerBase()}/info`),
    );
  }

  private async dockerBase(): Promise<string> {
    return `/api/endpoints/${await this.environmentId()}/docker`;
  }

  /** Drops cached reads; credentials and the resolved environment survive. */
  invalidate(): void {
    this.cache.invalidate();
  }

  close(): void {
    if (this.ownsDispatcher && this.dispatcher) void this.dispatcher.close();
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
