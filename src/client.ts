import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { TtlCache, TTL } from './cache';
import { PortainerError, type AuthMode } from './errors';
import { LogDemuxer, type LogFrame } from './logframes';
import { redactValue } from './redact';
import {
  EDGE_ENVIRONMENT_TYPES,
  type Capabilities,
  type DockerContainer,
  type DockerContainerInspect,
  type DockerDiskUsage,
  type DockerImage,
  type DockerImagePrune,
  type DockerImageRemoval,
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

/** What to read of a container's log. */
export interface LogOptions {
  /** Lines from the end. Always sent — an unbounded log can be gigabytes. */
  tail?: number;
  /** Unix seconds; only entries after this. */
  since?: number;
  /** Prefix each line with Docker's RFC3339 timestamp. */
  timestamps?: boolean;
  stdout?: boolean;
  stderr?: boolean;
}

/** Lines to read when the caller does not say. */
export const DEFAULT_LOG_TAIL = 200;
/** The most any single request may ask for, however large a number it sends. */
export const MAX_LOG_TAIL = 5000;

/**
 * The Docker query for a log request.
 *
 * `tail` is clamped rather than trusted: a container that has been running for
 * a year can hold gigabytes, and an unbounded read would hold the whole thing
 * in memory on the way through.
 */
export function logQuery(options: LogOptions = {}, follow = false): string {
  const stdout = options.stdout !== false;
  const stderr = options.stderr !== false;
  const tail = Math.min(
    MAX_LOG_TAIL,
    Math.max(1, Math.floor(options.tail ?? DEFAULT_LOG_TAIL) || DEFAULT_LOG_TAIL),
  );

  const query = new URLSearchParams();
  // Docker answers 400 when neither stream is asked for, so a caller that turns
  // both off gets stdout rather than an error about a request it did not make.
  query.set('stdout', String(stdout || !stderr));
  query.set('stderr', String(stderr));
  query.set('tail', String(tail));
  if (options.since !== undefined && Number.isFinite(options.since)) {
    query.set('since', String(Math.max(0, Math.floor(options.since))));
  }
  if (options.timestamps) query.set('timestamps', 'true');
  if (follow) query.set('follow', 'true');
  return query.toString();
}

/** Portainer's answer to a create, when it answered with one. */
function asStack(value: unknown): Stack | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { Id?: unknown; Name?: unknown };
  if (typeof candidate.Id !== 'number' || typeof candidate.Name !== 'string') return undefined;
  return value as Stack;
}

/**
 * Environment variables in the shape Portainer stores them, with anything
 * misshapen dropped rather than sent on as a variable named "undefined".
 */
function pairs(env: readonly StackEnvVar[]): { name: string; value: string }[] {
  return env
    .filter((entry) => typeof entry?.name === 'string' && entry.name.length > 0)
    .map((entry) => ({ name: entry.name, value: String(entry.value ?? '') }));
}

/** One `NAME=value` pair as Portainer carries it. */
export interface StackEnvVar {
  name: string;
  value: string;
}

/** A compose file and the environment it is deployed with. */
export interface StackUpdate {
  content: string;
  env?: StackEnvVar[];
  /**
   * Removes services that are no longer in the file. Off by default: a compose
   * file missing a service by accident should not delete it.
   */
  prune?: boolean;
  /** Re-pulls each image rather than deploying whatever is already local. */
  pullImage?: boolean;
}

/** What an update changed beyond the file itself. */
export interface StackUpdateResult {
  /**
   * True when the stack had a webhook or a polling interval, which Portainer
   * discards on update and this request could not preserve.
   */
  autoUpdateRemoved: boolean;
}

/** A redeploy of a stack whose file lives in git; the file comes from there. */
export interface StackRedeploy {
  prune?: boolean;
  pullImage?: boolean;
  /** Credentials for a private repository, when the stack needs them again. */
  authentication?: { username: string; password: string };
  tlsSkipVerify?: boolean;
}

export interface StackFromString {
  name: string;
  content: string;
  env?: StackEnvVar[];
}

export interface StackFromRepository {
  name: string;
  repositoryUrl: string;
  /** A full ref — `refs/heads/main`, not `main`. */
  reference?: string;
  composeFile?: string;
  env?: StackEnvVar[];
  authentication?: { username: string; password: string };
  tlsSkipVerify?: boolean;
}

/**
 * The slice of the Docker Engine API this plugin uses, reached through
 * Portainer's docker proxy. The environment id is already bound to the client,
 * so no call site passes one.
 *
 * Mostly reads. What it writes is container lifecycle and image reclamation,
 * and nothing else: volumes and networks are listed and never touched, because
 * a deleted volume is unrecoverable and a detached network breaks a container
 * that goes on reporting itself as running.
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
  /** Freezes the processes; the container stays "running" to the daemon. */
  pauseContainer(id: string): Promise<void>;
  unpauseContainer(id: string): Promise<void>;

  // ── logs ────────────────────────────────────────────────────────────────

  /** A bounded slice of the log, demuxed. `tail` is always sent. */
  logs(id: string, options?: LogOptions): Promise<LogFrame[]>;
  /**
   * The log as it happens.
   *
   * The promise settles when Portainer has answered, so a container that does
   * not exist rejects here rather than part-way through an apparently healthy
   * stream. The iterable then yields frames until Docker ends the stream or the
   * signal fires — and the signal is the only thing that ends it early, so a
   * caller that forgets to abort leaks a connection to Portainer.
   */
  logStream(
    id: string,
    signal: AbortSignal,
    options?: LogOptions,
  ): Promise<AsyncIterable<LogFrame>>;
  removeContainer(id: string, opts?: { force?: boolean; removeVolumes?: boolean }): Promise<void>;

  // ── images ──────────────────────────────────────────────────────────────

  /**
   * Removes one image, named by id or by tag.
   *
   * Never forced. Docker refuses (409) to remove an image a container still
   * references — running or stopped — and that refusal is what keeps the image
   * Signal K itself runs from out of reach, without this plugin having to
   * discover which image that is. Forcing would step over exactly that guard.
   *
   * An image carrying several tags is refused too, for a reason worth reading
   * in Docker's own words: removing it by id would take every tag with it.
   * Naming one tag untags just that one, which is what the answer reports.
   */
  removeImage(reference: string): Promise<DockerImageRemoval[]>;

  /**
   * Reclaims the space images are holding.
   *
   * `all` is the difference between tidying and losing something: without it
   * Docker removes only untagged layers, which nothing could deploy from
   * anyway. With it, every image no container references goes — including the
   * previous tag of a service that was just updated, which is what a rollback
   * would have used. Getting those back needs the internet a boat may not have.
   */
  pruneImages(options?: { all?: boolean }): Promise<DockerImagePrune>;
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

/**
 * Cache keys an image mutation can change: the image list itself, and the disk
 * usage that counts it. The container list is untouched — removing an image
 * cannot remove a container, because Docker refuses whenever one is using it.
 */
const IMAGE_VOLATILE_KEYS = ['images', 'df'] as const;

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
  /**
   * The budget for a write, separate from the read timeout.
   *
   * A stack deploy that pulls a multi-gigabyte image routinely takes minutes,
   * and Portainer answers only when it is done. Held to the 10s read budget the
   * request aborts while the deploy carries on and succeeds, so the operator is
   * told the instance is unreachable and then finds the stack running.
   */
  writeTimeoutMs?: number;
  environment?: EnvironmentSelector;
  /** Test seam: inject an undici MockAgent instead of a real connection. */
  dispatcher?: Dispatcher;
  log?: (message: string) => void;
}

interface RawInit {
  headers?: Record<string, string>;
  json?: unknown;
  timeoutMs?: number;
  /**
   * Caller-owned lifetime, replacing the request timeout entirely.
   *
   * A timeout aborts the whole exchange, body included, so a follow stream that
   * is meant to stay open until the operator closes it cannot have one. The
   * caller takes responsibility for ending it instead.
   */
  signal?: AbortSignal;
}

/**
 * One client per configured Portainer instance. The environment id is resolved
 * once and bound to the instance, so no call site can pass the wrong one.
 */
export class PortainerClient {
  private readonly baseUrl: string;
  private readonly auth: AuthOptions;
  private readonly timeoutMs: number;
  private readonly writeTimeoutMs: number;
  private selector: EnvironmentSelector;
  private readonly dispatcher: Dispatcher | undefined;
  /** Kept for the exec WebSocket, which is a ws client rather than a fetch. */
  private readonly tls: TlsOptions | undefined;
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
    // Five minutes: long enough for a compose pull over a marina uplink, short
    // enough that a wedged connection is eventually released rather than held
    // for the life of the process.
    this.writeTimeoutMs = options.writeTimeoutMs ?? 300_000;
    this.selector = options.environment ?? {};
    this.log = options.log ?? (() => {});

    this.tls = options.tls;
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
     * How long to wait for a stop or a restart.
     *
     * Docker holds the request open for the whole grace period before it sends
     * SIGKILL, so `stopContainer(id, 30)` against the 10s read budget aborts a
     * call that was going to succeed — and Docker stops the container anyway,
     * leaving the operator with an error and a stopped container. The extra 10s
     * covers the kill itself and the round trip.
     */
    const stopBudget = (timeoutSeconds?: number): number | undefined =>
      timeoutSeconds === undefined
        ? undefined
        : Math.max(this.timeoutMs, (Math.max(0, Math.floor(timeoutSeconds)) + 10) * 1000);

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
    const mutate = async (method: string, path: string, timeoutMs?: number): Promise<void> => {
      // `notModifiedIsFine`: Docker answers 304 for a lifecycle call that asks
      // for the state a container is already in — starting a running one,
      // stopping a stopped one. That is documented, idempotent success, and
      // `Response.ok` is false for it, so without this a second Stop reads as
      // a failure. Worse for a Signal K client asserting `state = running` on
      // a schedule: every run after the first would report an error.
      const response = await this.send(
        method,
        `${await this.dockerBase()}${path}`,
        timeoutMs === undefined ? {} : { timeoutMs },
        true,
        true,
      );
      // Docker answers 204 for these; the body is drained so the connection is
      // released rather than left for the collector.
      await response.body?.cancel().catch(() => undefined);
      this.cache.invalidate(CONTAINER_VOLATILE_KEYS);
    };

    /**
     * A state-changing proxy call whose answer is the point of making it.
     *
     * `mutate` above throws the body away, which is right for a lifecycle call
     * — Docker answers those with 204 and nothing else. An image removal
     * answers with what it removed, and for a prune that list is the only
     * account of what was actually destroyed.
     */
    const mutateJson = async <T>(
      method: string,
      path: string,
      keys: readonly string[],
      timeoutMs?: number,
    ): Promise<T> => {
      const body = await this.json<T>(
        method,
        `${await this.dockerBase()}${path}`,
        timeoutMs === undefined ? {} : { timeoutMs },
      );
      this.cache.invalidate(keys);
      return body;
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
        mutate(
          'POST',
          `/containers/${encode(id)}/stop${seconds(timeoutSeconds)}`,
          stopBudget(timeoutSeconds),
        ),

      restartContainer: (id, timeoutSeconds) =>
        mutate(
          'POST',
          `/containers/${encode(id)}/restart${seconds(timeoutSeconds)}`,
          stopBudget(timeoutSeconds),
        ),

      pauseContainer: (id) => mutate('POST', `/containers/${encode(id)}/pause`),

      unpauseContainer: (id) => mutate('POST', `/containers/${encode(id)}/unpause`),

      killContainer: (id, signal) =>
        mutate(
          'POST',
          `/containers/${encode(id)}/kill${signal ? `?signal=${encodeURIComponent(signal)}` : ''}`,
        ),

      logs: async (id, options = {}) => {
        const path = `${await this.dockerBase()}/containers/${encode(id)}/logs?${logQuery(options)}`;
        const response = await this.send('GET', path, {}, true);
        const demuxer = new LogDemuxer();
        const bytes = new Uint8Array(await response.arrayBuffer());
        return [...demuxer.push(bytes), ...demuxer.flush()];
      },

      logStream: async (id, signal, options = {}) => {
        const path = `${await this.dockerBase()}/containers/${encode(id)}/logs?${logQuery(
          options,
          true,
        )}`;
        // The caller's signal governs the body, which is meant to stay open —
        // but the handshake still needs a bound, or a Portainer that accepts
        // the connection and then says nothing holds the request forever. The
        // two are composed for the send and the timer cleared as soon as the
        // response arrives, so only the caller can end it from then on.
        const handshake = new AbortController();
        const timer = setTimeout(() => handshake.abort(), this.timeoutMs);
        try {
          const response = await this.send(
            'GET',
            path,
            { signal: AbortSignal.any([signal, handshake.signal]) },
            true,
          );
          return readLogFrames(response);
        } finally {
          clearTimeout(timer);
        }
      },

      removeContainer: (id, opts = {}) =>
        mutate(
          'DELETE',
          // v defaults to false: removing a container's volumes destroys data
          // and must never be implied by removing the container.
          `/containers/${encode(id)}?force=${opts.force ? 'true' : 'false'}&v=${
            opts.removeVolumes ? 'true' : 'false'
          }`,
        ),

      // No `force`, and no `noprune`: see the interface for why the first is
      // absent, and Docker's default for the second already drops the untagged
      // parents an image leaves behind, which is the space this exists to free.
      //
      // The reference is encoded whole, so a registry tag's slashes travel as
      // %2F and reach Docker as part of the image name rather than as more
      // path. The panel sends an id, which has none — a slashed tag only
      // arrives from a direct API caller.
      removeImage: (reference) =>
        mutateJson<DockerImageRemoval[]>(
          'DELETE',
          `/images/${encode(reference)}`,
          IMAGE_VOLATILE_KEYS,
          this.writeTimeoutMs,
        ),

      // The filter is always sent rather than left to Docker's default, which
      // is `dangling=true`. Depending on a default for the difference between
      // removing untagged layers and removing every unused image is how a
      // future Docker changing its mind takes a boat's images with it.
      pruneImages: (options = {}) =>
        mutateJson<DockerImagePrune>(
          'POST',
          `/images/prune?filters=${encodeURIComponent(
            JSON.stringify({ dangling: [options.all ? 'false' : 'true'] }),
          )}`,
          IMAGE_VOLATILE_KEYS,
          // The write budget: a prune deletes layer by layer, and a year of
          // redeploys on a slow SD card is minutes of work, not seconds.
          this.writeTimeoutMs,
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
    notModifiedIsFine = false,
  ): Promise<Response> {
    const auth = await this.authHeaders();
    // The JWT this attempt carries, read with no await in between so it is the
    // one the headers were built from. A 401 retry compares against it rather
    // than clearing blindly; see below.
    const attemptJwt = this.jwt?.token;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(init.headers ?? {}),
      ...auth,
    };
    if (init.json !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = (await undiciFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      })) as unknown as Response;
    } catch (cause) {
      throw PortainerError.fromTransport(cause, method, path, this.baseUrl);
    }

    // A rejected JWT is renewable; a rejected API key is not.
    if (res.status === 401 && mayRetryAuth && this.auth.mode === 'userPass') {
      // Only the token this attempt actually used is dropped. Clearing
      // unconditionally throws away a token a sibling request refreshed
      // microseconds earlier, so after a Portainer restart every in-flight
      // request queues its own POST /api/auth instead of the one that
      // jwtToken() would have coalesced them into.
      if (this.jwt && this.jwt.token === attemptJwt) this.jwt = undefined;
      // Release the connection before the retry rather than leaving the body
      // dangling for the garbage collector.
      await res.body?.cancel().catch(() => undefined);
      this.log('Portainer rejected the cached JWT, re-authenticating');
      // `notModifiedIsFine` is passed on: dropping it turned Docker's 304
      // ("already in that state") from idempotent success into a thrown error
      // whenever the retry was the attempt that reached Portainer.
      return this.send(method, path, init, false, notModifiedIsFine);
    }

    // 304 is only success for the callers that say so: Docker uses it to mean
    // "already in that state" on the lifecycle routes, and nothing else here
    // sends a conditional request that could earn one honestly.
    if (notModifiedIsFine && res.status === 304) return res;
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
    const chosen = await this.environmentOrNone();
    if (chosen) return chosen;

    const environments = await this.listEnvironments({ excludeSnapshots: true });
    throw new PortainerError({
      status: 400,
      method: 'GET',
      path: '/api/endpoints',
      message: 'Portainer has several environments and none is selected',
      hint: `choose one in the Portainer panel — available: ${describe(environments)}`,
    });
  }

  /**
   * The environment this client would use, or undefined while the choice is
   * still open. The distinction matters to the picker: it has to list what
   * there is to choose from, and an unmade choice is the reason it is being
   * asked rather than a failure. A selection that names something Portainer
   * does not have is still an error here — that is a wrong answer, not an
   * absent one.
   */
  async environmentOrNone(): Promise<Environment | undefined> {
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

      // Several, and no choice made: not an error at this level. The caller
      // decides what an open question means — `environment()` refuses, the
      // picker offers the list.
      return undefined;
    });
  }

  /**
   * Points this client at a different environment, as the panel's picker does.
   * Every cached read belongs to the environment it was read from — the
   * resolved environment among them — so they all go.
   */
  selectEnvironment(id: number | null): void {
    this.selector = id === null ? {} : { id };
    this.cache.invalidate();
  }

  /** What the picker currently has selected, without asking Portainer. */
  get selection(): EnvironmentSelector {
    return { ...this.selector };
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
   * The stack with this id, once it is established that it belongs here.
   *
   * Portainer would happily act on any stack the configured credential can
   * reach, including one belonging to a different environment, so every call
   * that names a stack id passes through this first. Returns the stack itself,
   * because what a caller may do with it depends on what it is — a swarm stack
   * and a git-backed stack take different routes.
   */
  private async ownStack(id: number, method: string, path: string): Promise<Stack> {
    const stacks = await this.listStacks();
    const stack = stacks.find((candidate) => candidate.Id === id);
    if (stack) return stack;
    throw new PortainerError({
      status: 404,
      method,
      path,
      message: `Stack ${id} does not belong to this environment`,
      hint: `stacks in this environment: ${
        stacks.map((candidate) => `${candidate.Id}:${candidate.Name}`).join(', ') || 'none'
      }`,
    });
  }

  /**
   * The compose or manifest file for a stack, as text.
   */
  async stackFile(id: number): Promise<string> {
    await this.ownStack(id, 'GET', `/api/stacks/${id}/file`);
    const payload = await this.json<{ StackFileContent?: string }>('GET', `/api/stacks/${id}/file`);
    return payload.StackFileContent ?? '';
  }

  /**
   * Runs a stack write and drops the reads it can change.
   *
   * A stack operation moves containers, so it invalidates the same keys a
   * container mutation does — the stack list, the container list, and the
   * inventory that follows from them.
   */
  private async stackWrite(method: string, path: string, body?: unknown): Promise<unknown> {
    // The write budget, not the read one: Portainer answers a deploy only once
    // compose has finished pulling and starting, which is minutes rather than
    // seconds for anything with an image to fetch.
    const response = await this.send(
      method,
      path,
      { ...(body === undefined ? {} : { json: body }), timeoutMs: this.writeTimeoutMs },
      true,
    );
    // Read defensively rather than through json(): Portainer answers a delete
    // with 204 and no body at all, and a stack write is not worth failing over
    // a body nobody needed.
    const text = await response.text().catch(() => '');
    this.cache.invalidate(CONTAINER_VOLATILE_KEYS);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  /** `?endpointId=`, which every stack write needs. */
  private async endpointQuery(): Promise<string> {
    return `endpointId=${await this.environmentId()}`;
  }

  /** Brings a stopped stack back up. */
  async startStack(id: number): Promise<void> {
    await this.ownStack(id, 'POST', `/api/stacks/${id}/start`);
    await this.stackWrite('POST', `/api/stacks/${id}/start?${await this.endpointQuery()}`);
  }

  /** Stops every container in the stack, leaving the stack defined. */
  async stopStack(id: number): Promise<void> {
    await this.ownStack(id, 'POST', `/api/stacks/${id}/stop`);
    await this.stackWrite('POST', `/api/stacks/${id}/stop?${await this.endpointQuery()}`);
  }

  /**
   * Deploys a new compose file and environment.
   *
   * `prune` and `pullImage` are sent explicitly rather than left to Portainer's
   * defaults: pruning removes services the new file no longer mentions, and a
   * file that lost a service by accident should not take the service with it.
   *
   * Refused for a git-backed stack. Portainer's update handler detaches the
   * stack from its repository and clears its auto-update settings — the stack
   * silently stops being the thing the repository describes, and no field in
   * this request says so. A git stack is changed in git and brought over with
   * redeploy.
   */
  async updateStack(id: number, update: StackUpdate): Promise<StackUpdateResult> {
    const stack = await this.ownStack(id, 'PUT', `/api/stacks/${id}`);
    if (stack.GitConfig?.URL) {
      throw new PortainerError({
        status: 400,
        method: 'PUT',
        path: `/api/stacks/${id}`,
        message: `Stack ${stack.Name} is deployed from a repository`,
        hint: 'updating it here would detach it from git and drop its auto-update settings; change the file in the repository and redeploy instead',
      });
    }
    await this.stackWrite('PUT', `/api/stacks/${id}?${await this.endpointQuery()}`, {
      StackFileContent: update.content,
      Env: pairs(update.env ?? stack.Env ?? []),
      Prune: update.prune === true,
      PullImage: update.pullImage === true,
    });
    // Portainer's update handler clears AutoUpdate, and the request has no
    // field that could have kept it. Reported rather than swallowed: a webhook
    // that stops firing is otherwise discovered by it not firing.
    return { autoUpdateRemoved: Boolean(stack.AutoUpdate?.Webhook ?? stack.AutoUpdate?.Interval) };
  }

  /**
   * Redeploys a git-backed stack from its repository.
   *
   * Refused for a stack that has no repository, rather than passed on: Portainer
   * answers that with a failure about a field the operator never filled in.
   */
  async redeployStack(id: number, options: StackRedeploy = {}): Promise<void> {
    const stack = await this.ownStack(id, 'PUT', `/api/stacks/${id}/git/redeploy`);
    if (!stack.GitConfig?.URL) {
      throw new PortainerError({
        status: 400,
        method: 'PUT',
        path: `/api/stacks/${id}/git/redeploy`,
        message: `Stack ${stack.Name} was not deployed from a repository`,
        hint: 'redeploy pulls the file from git; for a file-based stack, send the new file instead',
      });
    }
    await this.stackWrite('PUT', `/api/stacks/${id}/git/redeploy?${await this.endpointQuery()}`, {
      RepositoryReferenceName: stack.GitConfig.ReferenceName ?? '',
      RepositoryAuthentication: options.authentication !== undefined,
      ...(options.authentication
        ? {
            RepositoryUsername: options.authentication.username,
            RepositoryPassword: options.authentication.password,
          }
        : {}),
      Env: pairs(stack.Env ?? []),
      Prune: options.prune === true,
      PullImage: options.pullImage === true,
      TLSSkipVerify: options.tlsSkipVerify === true,
    });
  }

  /**
   * A new stack from a compose file held in the request.
   *
   * Swarm and standalone are different routes with different required fields,
   * and which one applies is a property of the environment rather than of the
   * request, so it is resolved here rather than asked of the caller.
   */
  async createStackFromString(stack: StackFromString): Promise<Stack | undefined> {
    const { swarm, swarmId } = await this.swarmTarget('/api/stacks/create/{type}/string');
    return asStack(
      await this.stackWrite(
        'POST',
        `/api/stacks/create/${swarm ? 'swarm' : 'standalone'}/string?${await this.endpointQuery()}`,
        {
          Name: stack.name,
          ...(swarm ? { SwarmID: swarmId } : {}),
          StackFileContent: stack.content,
          Env: pairs(stack.env ?? []),
        },
      ),
    );
  }

  /** A new stack whose compose file lives in a git repository. */
  async createStackFromRepository(stack: StackFromRepository): Promise<Stack | undefined> {
    const { swarm, swarmId } = await this.swarmTarget('/api/stacks/create/{type}/repository');
    return asStack(
      await this.stackWrite(
        'POST',
        `/api/stacks/create/${
          swarm ? 'swarm' : 'standalone'
        }/repository?${await this.endpointQuery()}`,
        {
          Name: stack.name,
          ...(swarm ? { SwarmID: swarmId } : {}),
          RepositoryURL: stack.repositoryUrl,
          ...(stack.reference ? { RepositoryReferenceName: stack.reference } : {}),
          ComposeFile: stack.composeFile ?? '',
          RepositoryAuthentication: stack.authentication !== undefined,
          ...(stack.authentication
            ? {
                RepositoryUsername: stack.authentication.username,
                RepositoryPassword: stack.authentication.password,
              }
            : {}),
          Env: pairs(stack.env ?? []),
          TLSSkipVerify: stack.tlsSkipVerify === true,
        },
      ),
    );
  }

  /**
   * Deletes a stack. Its volumes are always left in place — Portainer CE's
   * stack delete accepts no volume parameter, so there is nothing to ask for
   * and nothing this method could pass on. Removing them is a separate step in
   * Portainer itself.
   */
  async deleteStack(id: number): Promise<void> {
    await this.ownStack(id, 'DELETE', `/api/stacks/${id}`);
    await this.stackWrite('DELETE', `/api/stacks/${id}?${await this.endpointQuery()}`);
  }

  /**
   * Creates an exec instance in a container, ready to be started by a socket.
   *
   * Two steps rather than one because that is how Docker works: this reserves
   * the instance and the WebSocket starts it. Doing the reservation over HTTP
   * means a container that is gone, or stopped, is an ordinary status rather
   * than a socket that opens and immediately closes for reasons nobody sees.
   */
  async createExec(containerId: string, command: readonly string[]): Promise<string> {
    const payload = await this.json<{ Id?: string }>(
      'POST',
      `${await this.dockerBase()}/containers/${encodeURIComponent(containerId)}/exec`,
      {
        json: {
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          Cmd: [...command],
        },
      },
    );
    if (!payload.Id) {
      throw new PortainerError({
        status: 502,
        method: 'POST',
        path: `/containers/${containerId}/exec`,
        message: 'Docker did not return an exec id',
        hint: 'the container may have stopped between the check and the request',
      });
    }
    return payload.Id;
  }

  /** Resizes the terminal behind an exec instance. */
  async resizeExec(execId: string, size: { rows: number; columns: number }): Promise<void> {
    const query = `h=${Math.max(1, Math.floor(size.rows))}&w=${Math.max(1, Math.floor(size.columns))}`;
    const response = await this.send(
      'POST',
      `${await this.dockerBase()}/exec/${encodeURIComponent(execId)}/resize?${query}`,
      {},
      true,
    );
    await response.body?.cancel().catch(() => undefined);
  }

  /**
   * Everything needed to open Portainer's exec WebSocket.
   *
   * Returned rather than opened here so the socket itself is somebody else's
   * problem: the relay owns the two sockets and their lifetimes, and this class
   * stays the thing that knows about Portainer.
   *
   * The credential goes in a header, which a browser could not do — this
   * connection is made by the plugin, which is the whole reason the browser
   * never sees a Portainer credential.
   */
  async execSocket(execId: string): Promise<{
    url: string;
    headers: Record<string, string>;
    tls: TlsOptions | undefined;
  }> {
    const environmentId = await this.environmentId();
    const base = this.baseUrl.replace(/^http/, 'ws');
    return {
      url: `${base}/api/websocket/exec?endpointId=${environmentId}&id=${encodeURIComponent(execId)}`,
      headers: await this.authHeaders(),
      tls: this.tls,
    };
  }

  /**
   * Which create route applies, and the swarm id it needs.
   *
   * A swarm create without SwarmID is refused by Portainer with a message about
   * a field the operator never saw, so a swarm that cannot report its id is
   * refused here with one they can act on.
   */
  private async swarmTarget(path: string): Promise<{ swarm: boolean; swarmId?: string }> {
    const capabilities = await this.capabilities();
    if (!capabilities.swarm) return { swarm: false };
    if (!capabilities.swarmId) {
      throw new PortainerError({
        status: 502,
        method: 'POST',
        path,
        message: 'The environment is a swarm but did not report a swarm id',
        hint: 'a swarm stack cannot be created without it; check that the Docker daemon is a swarm manager rather than a worker',
      });
    }
    return { swarm: true, swarmId: capabilities.swarmId };
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
      writeTimeoutMs: this.writeTimeoutMs,
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
 *
 * Portainer already answers the edge question itself, in `Heartbeat`, and that
 * answer is preferred over recomputing one here. Recomputing is what made
 * healthy remote environments read as "down": Portainer stamps
 * `LastCheckInDate` with its own clock, and works the window out from the
 * intervals that only it can see. A local recomputation gets both wrong — any
 * clock skew between this host and Portainer's counts straight against the
 * window, and an async edge agent checks in on its ping interval (60s by
 * default) while `EdgeCheckinInterval` in the same payload still carries the
 * 5s standard-mode default, a window three times too short for a link that is
 * perfectly healthy.
 */
export function environmentHealth(environment: Environment, nowMs = Date.now()): EnvironmentHealth {
  if (EDGE_ENVIRONMENT_TYPES.includes(environment.Type)) {
    if (typeof environment.Heartbeat === 'boolean') return environment.Heartbeat ? 'up' : 'down';

    if (!environment.LastCheckInDate) return 'down';
    const ageSeconds = nowMs / 1000 - environment.LastCheckInDate;
    return ageSeconds <= 2 * edgeCheckinInterval(environment) + EDGE_GRACE_SECONDS ? 'up' : 'down';
  }
  if (environment.Status === 1) return 'up';
  if (environment.Status === 2) return 'down';
  return 'unknown';
}

/**
 * How often the agent is expected to check in, for the Portainer versions that
 * do not publish `Heartbeat`. Mirrors Portainer's own rule: in async mode the
 * agent checks in on the shortest of its ping, command and snapshot intervals
 * — capped at 60s — and `EdgeCheckinInterval` does not apply at all.
 */
function edgeCheckinInterval(environment: Environment): number {
  const edge = environment.Edge;
  if (edge?.AsyncMode) {
    const intervals = [edge.PingInterval, edge.CommandInterval, edge.SnapshotInterval].filter(
      (value): value is number => typeof value === 'number' && value > 0,
    );
    return Math.min(EDGE_DEFAULT_INTERVAL_SECONDS, ...intervals);
  }
  return environment.EdgeCheckinInterval && environment.EdgeCheckinInterval > 0
    ? environment.EdgeCheckinInterval
    : EDGE_DEFAULT_INTERVAL_SECONDS;
}

/**
 * Frames from an open log response, yielded as they arrive.
 *
 * A free function rather than a method: it needs nothing from the client, and
 * keeping it out of the class makes it plain that the response is already open
 * by the time anything here runs.
 */
async function* readLogFrames(response: Response): AsyncIterable<LogFrame> {
  const body = response.body;
  if (!body) return;

  const demuxer = new LogDemuxer();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield* demuxer.push(value);
    }
    yield* demuxer.flush();
  } finally {
    // The caller's signal firing mid-read can leave cancel() rejecting, and a
    // rejection in a finally would mask whatever ended the loop.
    await reader.cancel().catch(() => undefined);
  }
}
