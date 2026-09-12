import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Agent, getGlobalDispatcher, fetch as undiciFetch, type Dispatcher } from 'undici';
import { TtlCache, TTL } from './cache';
import { PortainerError, type AuthMode } from './errors';
import { LogDemuxer, type LogFrame } from './logframes';
import { redactValue } from './redact';
import {
  EDGE_ENVIRONMENT_TYPES,
  EnvironmentType,
  type Capabilities,
  type ContainerStats,
  type DockerContainer,
  type DockerContainerInspect,
  type DockerContainerStats,
  type DockerContainerTop,
  type DockerDiskUsage,
  type DockerEvent,
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
  type EnvironmentSupport,
  type ImagePullResult,
  type PortainerRegistry,
  type PortainerStatus,
  type PortainerVersion,
  type RegistryChoice,
  type Stack,
  StackStatus,
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

/**
 * A polling interval in milliseconds, or undefined when it is not one.
 *
 * Portainer stores the string and hands it to Go's `time.ParseDuration`, so
 * the grammar has to be Go's. Only hours, minutes and seconds are taken: the
 * smaller units Go also knows are every one of them shorter than the floor
 * below, and a duration that cannot be read is refused rather than rounded, so
 * an operator who typed one thing is never quietly given another.
 */
function intervalMs(interval: string): number | undefined {
  if (!/^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(interval) || interval === '') return undefined;
  const unit = (suffix: string): number =>
    Number(new RegExp(`(\\d+)${suffix}`).exec(interval)?.[1] ?? 0);
  return ((unit('h') * 60 + unit('m')) * 60 + unit('s')) * 1_000;
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
/**
 * What auto-update should look like after the write.
 *
 * Absent fields are off, not unchanged: Portainer's route replaces the whole
 * `AutoUpdate` record, so there is nothing here that could mean "leave that
 * part alone" — the caller says what the stack should end up with.
 */
export interface StackAutoUpdate {
  /** How often to poll the repository. Absent means do not poll. */
  interval?: string;
  /** Whether Portainer should hold a webhook URL that redeploys this stack. */
  webhook?: boolean;
  /** Re-pull the images, rather than only re-reading the compose file. */
  pullImage?: boolean;
  /** Redeploy on every poll, even when the repository has not moved. */
  force?: boolean;
}

/** Auto-update as it stands after the write, for the panel to show. */
export interface StackAutoUpdateState {
  /** Absent when nothing polls. */
  interval?: string;
  /** The webhook id, when Portainer holds one. The URL is built from it. */
  webhook?: string;
  pullImage: boolean;
  force: boolean;
}

/**
 * The shortest polling interval this plugin will set.
 *
 * Portainer's scheduler takes whatever `time.ParseDuration` accepts and never
 * looks at the value, so `0s` — and a negative duration — start a job that
 * fetches the repository as fast as the link allows. On a boat that is the
 * difference between a background task and a bill, and Portainer's own UI
 * offers nothing shorter than a minute either.
 */
const MIN_AUTO_UPDATE_MS = 60_000;

export interface StackRedeploy {
  prune?: boolean;
  pullImage?: boolean;
  /** Credentials for a private repository, when the stack needs them again. */
  authentication?: { username: string; password: string };
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

  // ── diagnostics ─────────────────────────────────────────────────────────

  /**
   * One reading of what a container is costing: CPU, memory, network and
   * disk. Docker takes two samples a second apart to compute the CPU share,
   * so this call takes about that long. Never cached — the point is now.
   */
  stats(id: string): Promise<ContainerStats>;
  /** The processes running inside a container, as `ps` would list them. */
  top(id: string): Promise<DockerContainerTop>;

  // ── images, fetched ─────────────────────────────────────────────────────

  /**
   * Pulls an image by reference, `name:tag` or `name@digest`, waiting for the
   * whole pull. Docker answers 200 as soon as it starts and reports a failure
   * — no such tag, no route to the registry — inside the progress stream, so
   * that stream is read to the end and the answer comes from its last word.
   */
  /**
   * Fetches an image, optionally through a registry Portainer has credentials
   * for.
   *
   * `registryId` names one of `registries()`; the plugin never sees the
   * password. Portainer's docker proxy intercepts `/images/create`, reads the
   * id out of the `X-Registry-Auth` header it is given, and replaces the whole
   * header with credentials from its own store before Docker sees it. So the
   * worst a caller can do with a wrong id is fail to authenticate.
   *
   * Omitted, no header is sent at all, which is the anonymous pull this had
   * before — right for Docker Hub and for any registry that needs no login.
   */
  pullImage(reference: string, registryId?: number): Promise<ImagePullResult>;

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
  /**
   * Docker's own account of what just changed, as it changes.
   *
   * The alternative is asking every few seconds and hoping the interval is
   * short enough — which on a boat is a trade between a stale panel and a
   * radio link spent re-listing containers that did not move. This costs one
   * idle connection per instance and reports a container's death in the
   * second it happens.
   *
   * Subscribed to containers only: images and networks change nothing this
   * plugin publishes, and every event that crosses the link is bandwidth.
   * Like `logStream`, the handshake is bounded but the body is not — the
   * caller's signal is the only thing that ends it.
   */
  eventStream(signal: AbortSignal): Promise<AsyncIterable<DockerEvent>>;
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

/**
 * Cache keys a stack write can change: everything a container mutation can,
 * plus the images a `PullImage` deploy fetches and the networks compose
 * creates and removes with the project.
 */
const STACK_VOLATILE_KEYS = [
  ...CONTAINER_VOLATILE_KEYS,
  ...IMAGE_VOLATILE_KEYS,
  'networks',
] as const;

/**
 * A JWT is valid for ~8h by default; renew at 7h so a long poll never
 * straddles expiry. The token's own `exp` claim shortens this when an
 * administrator has set a shorter session timeout.
 */
const JWT_MAX_AGE_MS = 7 * 60 * 60 * 1000;
/** How long before a token's own expiry it is renewed. */
const JWT_RENEW_MARGIN_MS = 60 * 1000;

/**
 * The least a response body is given to finish arriving.
 *
 * The request timeout bounds the handshake — connect, send, first byte of the
 * answer — and a body then gets at least this long on top of it. Holding both
 * to one 10s budget made a 5000-line log or a large container list fail over
 * a slow marina link with "no response before the configured timeout", when
 * Portainer had answered within a second and the bytes were still coming.
 */
const BODY_BUDGET_MIN_MS = 60_000;

/**
 * How long `close()` waits for undici to drain in-flight requests before it
 * destroys the connections instead. `Agent.close()` never resolves while a
 * response body is left unconsumed, and a plugin stopping mid-deploy should
 * not keep a socket open for the life of the process.
 */
const CLOSE_GRACE_MS = 5_000;

/**
 * undici's dispatcher as it was before anything in this process changed it.
 *
 * Read once, at load. Anything else there later — a proxy agent the host
 * installed, a mock agent a test installed — was put there deliberately and
 * is honoured rather than bypassed by an agent of this client's own.
 */
const PRISTINE_GLOBAL_DISPATCHER: Dispatcher = getGlobalDispatcher();

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
  /** The cached token and the monotonic instant it should be renewed at. */
  private jwt: { token: string; renewAt: number } | undefined;
  private jwtInFlight: Promise<string> | undefined;
  /**
   * The read budget a standard-mode Edge environment needs for its proxy
   * calls, learned when the environment is resolved; see `readBudget`.
   */
  private edgeBudgetMs: number | undefined;

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
    const tls = options.tls;
    const configured = Boolean(
      tls && (tls.ca || tls.rejectUnauthorized === false || tls.servername),
    );
    // Something has replaced undici's process-wide dispatcher: a proxy agent
    // the Signal K server installed, or a test's mock. That is a deliberate
    // act by whoever owns this process, so it is used as it stands — and not
    // closed here, because it is not this client's to close. TLS settings
    // are the exception: they are this instance's, and an Agent has to be
    // built to carry them.
    const installed = getGlobalDispatcher();
    if (options.dispatcher) {
      this.dispatcher = options.dispatcher;
      this.ownsDispatcher = false;
    } else if (!configured && installed !== PRISTINE_GLOBAL_DISPATCHER) {
      this.dispatcher = installed;
      this.ownsDispatcher = false;
    } else {
      // Always an Agent of its own, TLS settings or not. undici's defaults
      // carry two budgets of their own — 300s to the headers, 300s between
      // body bytes — that fire regardless of the signal a request was given:
      // a follow stream on a container that prints hourly was torn down after
      // five quiet minutes and reconnected by the browser, forever, and a
      // deploy that legitimately took longer than that failed as unreachable
      // while Portainer carried on and finished it. Both are off, so the
      // request's own signal is the only thing that ends it. An owned Agent
      // is also one the plugin can close: connections pooled in undici's
      // process-global dispatcher outlive the plugin stopping.
      this.dispatcher = new Agent({
        headersTimeout: 0,
        bodyTimeout: 0,
        ...(configured && tls
          ? {
              connect: {
                ca: tls.ca || undefined,
                rejectUnauthorized: tls.rejectUnauthorized !== false,
                servername: tls.servername || undefined,
              },
            }
          : {}),
      });
      this.ownsDispatcher = true;
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
    const stopBudget = (timeoutSeconds?: number): number =>
      timeoutSeconds === undefined
        ? // No `t` means Docker waits the container's own grace period — 10s
          // by default, a minute or more for a database that asked for it in
          // its compose file — and that period is not known here without an
          // inspect. So a stop that names no grace period gets the write
          // budget, as a deploy does: held to the 10s read budget it aborted
          // at the very moment Docker was about to SIGKILL, and the operator
          // was told the instance was unreachable while the container
          // stopped anyway.
          Math.max(this.timeoutMs, this.writeTimeoutMs)
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
     * Reads a stream of JSON progress lines to its end and returns the last
     * word of it: Docker answers a pull with 200 the moment it starts, and a
     * failure — no such tag, no route to the registry — arrives inside the
     * stream as `{"error": …}` rather than as a status.
     *
     * Read a line at a time rather than buffered whole. Docker emits a line
     * per layer per tick, so a multi-layer image over a boat's uplink is a
     * stream with no bound on its length — and only the newest line is worth
     * anything once the one before it has been read.
     */
    const readPullProgress = async (
      response: Response,
      method: string,
      path: string,
    ): Promise<ImagePullResult> => {
      let status = '';
      let read = 0;
      const protocolError = (why: string): PortainerError =>
        new PortainerError({
          status: 502,
          method,
          path,
          message: `Docker did not report what it did with the image: ${why}`,
          hint: 'the pull may or may not have happened; check the image list',
        });
      const take = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let entry: { status?: unknown; error?: unknown; errorDetail?: { message?: unknown } };
        try {
          entry = JSON.parse(trimmed) as typeof entry;
        } catch {
          return;
        }
        const failure =
          typeof entry.errorDetail?.message === 'string'
            ? entry.errorDetail.message
            : typeof entry.error === 'string'
              ? entry.error
              : undefined;
        if (failure) {
          throw new PortainerError({
            status: 502,
            method,
            path,
            message: `Docker could not pull the image: ${failure}`,
            hint: 'check the image name and tag, and that the registry is reachable from the Docker host',
            body: failure,
          });
        }
        read += 1;
        if (typeof entry.status === 'string') status = entry.status;
      };

      // No body at all is not an empty pull: Docker answers `/images/create`
      // with a progress stream and nothing else, so an answer without one came
      // from something in between — a proxy that buffered it away, a tunnel
      // that dropped it — and reporting it as a completed pull would tell the
      // operator an image is there when nothing has said so.
      const body = response.body;
      if (!body) throw protocolError('the answer carried no progress stream');
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let held = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) held += decoder.decode(value, { stream: true });
          for (let at = held.indexOf('\n'); at !== -1; at = held.indexOf('\n')) {
            take(held.slice(0, at));
            held = held.slice(at + 1);
          }
          // A line longer than any progress line Docker writes is not one.
          // Held, it would put the bound back where reading a line at a time
          // took it from; skipped, it would let a stream that is not Docker's
          // pass for a pull that worked. So the buffer goes and so does the
          // answer.
          if (held.length > MAX_PULL_LINE_BYTES) {
            held = '';
            throw protocolError(`a progress line ran past ${MAX_PULL_LINE_BYTES} bytes`);
          }
        }
        held += decoder.decode();
        take(held);
        // Docker says something about every pull, an image already current
        // included — that one answers "Status: Image is up to date for …". A
        // stream that said nothing this could read is not a pull that worked,
        // and answering `ok` for it tells the operator an image is there when
        // nothing has said so.
        if (read === 0) throw protocolError('nothing in the stream was a progress record');
      } catch (cause) {
        // A failure Docker reported inside the stream is the answer, not a
        // transport fault, and must reach the caller as it was written.
        if (cause instanceof PortainerError) throw cause;
        throw PortainerError.fromTransport(cause, method, path, this.baseUrl);
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return { status };
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

      stats: async (id) => {
        // `stream=false` has Docker take two samples a second apart, which is
        // what a CPU share is computed from; `one-shot=true` would answer at
        // once with an empty `precpu_stats` and no way to tell.
        const path = `${await this.dockerBase()}/containers/${encode(id)}/stats?stream=false`;
        return summarizeStats(await this.json<DockerContainerStats>('GET', path));
      },

      top: async (id) => {
        const payload = await this.json<DockerContainerTop>(
          'GET',
          `${await this.dockerBase()}/containers/${encode(id)}/top`,
        );
        return {
          Titles: Array.isArray(payload?.Titles) ? payload.Titles : [],
          Processes: Array.isArray(payload?.Processes) ? payload.Processes : [],
        };
      },

      pullImage: async (reference, registryId) => {
        const { name, tag } = splitImageReference(reference);
        const query = new URLSearchParams({ fromImage: name });
        if (tag) query.set('tag', tag);
        const path = `${await this.dockerBase()}/images/create?${query.toString()}`;
        // The write budget: a pull is a download, and on a boat's uplink a
        // multi-hundred-megabyte image is minutes of it.
        const response = await this.send(
          'POST',
          path,
          {
            timeoutMs: this.writeTimeoutMs,
            ...(registryId === undefined ? {} : { headers: registryAuthHeader(registryId) }),
          },
          true,
        );
        const result = await readPullProgress(response, 'POST', path);
        this.cache.invalidate(IMAGE_VOLATILE_KEYS);
        return { reference, ...result };
      },

      logs: async (id, options = {}) => {
        const path = `${await this.dockerBase()}/containers/${encode(id)}/logs?${logQuery(options)}`;
        const response = await this.send('GET', path, {}, true);
        // Streamed rather than buffered whole: `tail` bounds lines, not
        // bytes, and a container that writes very long lines can put tens of
        // megabytes behind 5000 of them.
        const frames: LogFrame[] = [];
        let bytes = 0;
        for await (const frame of readLogFrames(response, (chunk) => {
          bytes += chunk;
          if (bytes > MAX_LOG_BYTES) {
            throw new PortainerError({
              status: 413,
              method: 'GET',
              path,
              message: `The log is larger than ${MAX_LOG_BYTES} bytes`,
              hint: 'ask for fewer lines with ?tail=, or follow the stream instead',
            });
          }
        })) {
          frames.push(frame);
        }
        return frames;
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
        //
        // The abort carries a TimeoutError as its reason. A bare abort() is
        // reported as the caller cancelling the request, which sends an
        // operator whose Portainer is slow looking for a fault in their own
        // browser.
        const handshake = new AbortController();
        const timer = setTimeout(
          () => handshake.abort(timeoutError('the log stream handshake', this.timeoutMs)),
          this.timeoutMs,
        );
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

      eventStream: async (signal) => {
        // `since` is deliberately absent: this stream is a prompt to go and
        // look, not a log to replay. Asking for the events of the last minute
        // on every reconnect would replay a burst the plugin has already seen
        // and re-read the container list for each one.
        const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
        const path = `${await this.dockerBase()}/events?filters=${filters}`;
        const handshake = new AbortController();
        const timer = setTimeout(
          () => handshake.abort(timeoutError('the event stream handshake', this.timeoutMs)),
          this.timeoutMs,
        );
        try {
          const response = await this.send(
            'GET',
            path,
            { signal: AbortSignal.any([signal, handshake.signal]) },
            true,
          );
          return readEventLines(response);
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
      // The reference is encoded a segment at a time, so a registry tag's
      // slashes stay slashes: Docker takes `/images/ghcr.io/owner/name:1.2`
      // as one name, and Portainer's proxy refuses a path that carries an
      // encoded separator outright. The panel sends an id, which has none — a
      // slashed tag only arrives from a direct API caller.
      // `async` for the sake of a reference this refuses: the encoder throws,
      // and a lifecycle method that returns a promise everywhere else must
      // not throw past the caller's await on one input in four.
      removeImage: async (reference) =>
        mutateJson<DockerImageRemoval[]>(
          'DELETE',
          `/images/${encodeImageReference(reference)}`,
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

    // Two budgets, not one. The request timeout bounds the handshake — connect,
    // send, the first byte of the answer — because that is where an
    // unreachable Portainer shows itself. The body then gets its own, longer
    // deadline: holding both to the same 10s made a large answer over a slow
    // link fail as "no response", when Portainer had answered within a second
    // and the bytes were still arriving. A caller-owned signal replaces both,
    // since the caller has taken responsibility for ending the exchange.
    const budget = init.timeoutMs ?? this.readBudget(path);
    const controller = new AbortController();
    const handshake = setTimeout(
      () => controller.abort(timeoutError('a response', budget)),
      budget,
    );
    let res: Response;
    try {
      res = (await undiciFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      })) as unknown as Response;
    } catch (cause) {
      throw PortainerError.fromTransport(cause, method, path, this.baseUrl);
    } finally {
      clearTimeout(handshake);
    }
    if (!init.signal) {
      // Unreferenced, and left to fire: a body that was consumed long ago is
      // aborted to no effect, and a body that stalled is the one this exists
      // for. Clearing it would need a hook into the moment the caller finishes
      // reading, which a fetch Response does not offer.
      const bodyBudget = Math.max(budget, BODY_BUDGET_MIN_MS);
      const body = setTimeout(
        () => controller.abort(timeoutError('the rest of the response', bodyBudget)),
        bodyBudget,
      );
      body.unref?.();
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
    return parseJsonBody<T>(await this.readText(res, method, path), res, method, path);
  }

  /**
   * The body as text, with a failure on the way reported as the transport
   * failure it is. `Response.text()` rejecting mid-body — the deadline above
   * firing, a connection reset — is otherwise a bare DOMException that the
   * facade answers with a 500 and no hint.
   */
  private async readText(res: Response, method: string, path: string): Promise<string> {
    try {
      return await res.text();
    } catch (cause) {
      throw PortainerError.fromTransport(cause, method, path, this.baseUrl);
    }
  }

  /**
   * The read budget for a request that named none.
   *
   * A standard-mode Edge agent is reached through a tunnel Portainer opens on
   * demand, and opening it means waiting for the agent's next check-in — up
   * to two intervals, which for a 30s interval is a minute. Held to the 10s
   * default, the first request after an idle spell aborted every time and
   * the environment read as unreachable. The proxy paths are the ones that
   * cross the tunnel; Portainer's own API answers at once.
   */
  private readBudget(path: string): number {
    if (this.edgeBudgetMs !== undefined && path.includes('/docker/')) {
      return Math.max(this.timeoutMs, this.edgeBudgetMs);
    }
    return this.timeoutMs;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.auth.mode === 'apiKey') return { 'x-api-key': this.auth.apiKey };
    return { authorization: `Bearer ${await this.jwtToken()}` };
  }

  private async jwtToken(): Promise<string> {
    if (this.auth.mode !== 'userPass') throw new Error('jwtToken called outside userPass mode');
    if (this.jwt && performance.now() < this.jwt.renewAt) return this.jwt.token;

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

    const payload = parseJsonBody<{ jwt?: unknown }>(
      await this.readText(res, 'POST', '/api/auth'),
      res,
      'POST',
      '/api/auth',
    );
    if (typeof payload?.jwt !== 'string' || payload.jwt.length === 0) {
      throw new PortainerError({
        status: 0,
        method: 'POST',
        path: '/api/auth',
        message: 'Portainer returned no jwt field',
        hint: 'the response did not look like a Portainer auth response — check the base URL',
      });
    }
    // Renewed before the token's own expiry when that comes sooner than the
    // default: an administrator can shorten the session timeout to minutes,
    // and a token cached for seven hours regardless would cost a rejected
    // request and a re-authentication every few minutes after that.
    const lifetime = jwtLifetimeMs(payload.jwt);
    const renewIn =
      lifetime === undefined
        ? JWT_MAX_AGE_MS
        : Math.max(0, Math.min(JWT_MAX_AGE_MS, lifetime - JWT_RENEW_MARGIN_MS));
    this.jwt = { token: payload.jwt, renewAt: performance.now() + renewIn };
    return payload.jwt;
  }

  // ---------------------------------------------------------------- typed API

  /**
   * Portainer's own version.
   *
   * `/api/system/status` exists from Portainer 2.17; the route it replaced,
   * `/api/status`, still answers on every later release but is deprecated.
   * The new one is asked first, and the old one only when the new one is not
   * there — so a 2.16 reports its version rather than nothing.
   */
  async systemStatus(): Promise<PortainerStatus> {
    try {
      return await this.json<PortainerStatus>('GET', '/api/system/status');
    } catch (cause) {
      if (!(cause instanceof PortainerError) || cause.status !== 404) throw cause;
      return this.json<PortainerStatus>('GET', '/api/status');
    }
  }

  /**
   * Whether Portainer itself has an update waiting, as Portainer reports it.
   *
   * `/api/system/version` is authenticated and needs 2.19 or newer; anything
   * that goes wrong here is a missing nicety, not a failure, so the answer is
   * simply absent.
   */
  async systemVersion(): Promise<PortainerVersion | undefined> {
    try {
      const version = await this.json<PortainerVersion>('GET', '/api/system/version');
      return typeof version === 'object' && version !== null ? version : undefined;
    } catch (cause) {
      this.log(
        `system version probe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return undefined;
    }
  }

  async listEnvironments(opts: { excludeSnapshots?: boolean } = {}): Promise<Environment[]> {
    const query = opts.excludeSnapshots === false ? '' : '?excludeSnapshots=true';
    return this.cache.get(`environments${query}`, TTL.environments, () =>
      this.json<Environment[]>('GET', `/api/endpoints${query}`),
    );
  }

  /**
   * The registries this environment may pull from.
   *
   * Asked per environment rather than globally: `GET /api/registries` is
   * admin-only and answers 403 for anyone else — its own message says to use
   * this route instead — and an API key made for a plugin has no business
   * being an admin one. The environment-scoped route is authenticated rather
   * than restricted, and returns what this environment is actually allowed to
   * use, which is the more useful answer anyway.
   *
   * Narrowed on the way through. Portainer hides the password, but the raw
   * record also carries GitLab, Quay, ECR and access-policy blocks that the
   * panel has no use for and that would travel through the facade for nothing.
   */
  async registries(): Promise<RegistryChoice[]> {
    const id = await this.environmentId();
    const raw = await this.cache.get(`registries:${id}`, TTL.environments, () =>
      this.json<PortainerRegistry[]>('GET', `/api/endpoints/${id}/registries`),
    );
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is PortainerRegistry => typeof entry?.Id === 'number')
      .map((entry) => ({
        id: entry.Id,
        // Portainer allows a registry with no name; the address is what an
        // operator recognises it by anyway.
        name: entry.Name?.trim() || entry.URL?.trim() || `Registry ${entry.Id}`,
        ...(entry.URL ? { url: entry.URL } : {}),
        authenticated: entry.Authentication === true,
      }));
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
      const chosen = this.chooseEnvironment(environments);
      if (chosen) {
        // A selection that names something the plugin cannot manage — a
        // Kubernetes cluster, an async Edge agent — is refused here, where
        // the reason can be said, rather than on the first proxy call, which
        // Portainer answers with an error about a tunnel or a manifest.
        const support = environmentSupport(chosen);
        if (!support.supported) {
          throw new PortainerError({
            status: 400,
            method: 'GET',
            path: '/api/endpoints',
            message: `Portainer environment ${chosen.Id}:${chosen.Name} cannot be managed by this plugin`,
            hint: support.reason,
          });
        }
        this.edgeBudgetMs = edgeReadBudgetMs(chosen);
      }
      return chosen;
    });
  }

  /** The selection rule, on its own so the refusals above stay readable. */
  private chooseEnvironment(environments: Environment[]): Environment | undefined {
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
      const matches = environments.filter((env) => env.Name.toLowerCase() === wanted);
      const match = matches[0];
      // Portainer allows two environments to share a name. Taking the first
      // would be a guess, and the id is how the choice is made unambiguous.
      if (matches.length > 1) {
        throw new PortainerError({
          status: 400,
          method: 'GET',
          path: '/api/endpoints',
          message: `Several Portainer environments are named "${this.selector.name}"`,
          hint: `choose one by id in the Portainer panel — matching: ${describe(matches)}`,
        });
      }
      if (match) return match;
      throw new PortainerError({
        status: 404,
        method: 'GET',
        path: '/api/endpoints',
        message: `Portainer environment named "${this.selector.name}" not found`,
        hint: `available: ${describe(environments)}`,
      });
    }

    if (environments.length === 0) {
      throw new PortainerError({
        status: 404,
        method: 'GET',
        path: '/api/endpoints',
        message: 'Portainer reports no environments',
        hint: 'either none is configured, or this credential is not authorized for any',
      });
    }

    // The unmade choice is made only when there is nothing to choose between:
    // one environment, or one the plugin could manage among several it could
    // not. The unsupported ones are not candidates, so they do not make the
    // question open.
    const only = environments[0];
    if (environments.length === 1 && only) return only;
    const manageable = environments.filter((env) => environmentSupport(env).supported);
    const candidate = manageable[0];
    if (manageable.length === 1 && candidate) return candidate;

    // Several, and no choice made: not an error at this level. The caller
    // decides what an open question means — `environment()` refuses, the
    // picker offers the list.
    return undefined;
  }

  /**
   * Points this client at a different environment, as the panel's picker does.
   * Every cached read belongs to the environment it was read from — the
   * resolved environment among them — so they all go.
   */
  selectEnvironment(id: number | null): void {
    this.selector = id === null ? {} : { id };
    this.edgeBudgetMs = undefined;
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
      // A swarm *manager*, not merely a swarm member. A worker reports its
      // node state as active too, but has no view of the cluster: every
      // service and node call is refused with "not a swarm manager", and a
      // stack create would be refused for the missing id it cannot report.
      const swarm = info.Swarm?.LocalNodeState === 'active' && info.Swarm.ControlAvailable === true;
      const result: Capabilities = { swarm };
      const swarmId = info.Swarm?.Cluster?.ID;
      if (swarm && swarmId) result.swarmId = swarmId;
      if (info.ServerVersion) result.dockerVersion = info.ServerVersion;
      if (status?.Version) result.portainerVersion = status.Version;
      return result;
    });
  }

  /**
   * The capabilities above, plus whether Portainer has an update waiting.
   *
   * Separate because the update check is a nicety and the capabilities are
   * not: the poller and the health report ask for capabilities on every
   * cycle, and neither should wait on a Portainer asking its own version
   * service. Only the panel's capabilities route asks for this.
   */
  async capabilitiesWithUpdate(): Promise<Capabilities> {
    const [capabilities, version] = await Promise.all([
      this.capabilities(),
      this.cache.get('system/version', TTL.dockerInfo, () => this.systemVersion()),
    ]);
    const result: Capabilities = { ...capabilities };
    if (typeof version?.LatestVersion === 'string' && version.LatestVersion) {
      result.portainerLatestVersion = version.LatestVersion;
    }
    if (typeof version?.UpdateAvailable === 'boolean') {
      result.portainerUpdateAvailable = version.UpdateAvailable;
    }
    return result;
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
    // Defensively: `json` casts whatever Portainer answered with, and a proxy
    // or a captive portal answering 200 with something else would otherwise
    // throw from `filter` rather than read as "no stacks".
    if (!Array.isArray(all)) return [];
    return all.filter((stack) => stack?.EndpointId === environmentId);
  }

  /**
   * One stack, fresh from Portainer rather than from the 15s-cached list, so
   * a deploy's outcome is read as it settles rather than as it was.
   */
  async stack(id: number): Promise<Stack> {
    const stack = await this.json<Stack>('GET', `/api/stacks/${id}`);
    const environmentId = await this.environmentId();
    if (typeof stack?.Id !== 'number' || stack.EndpointId !== environmentId) {
      throw new PortainerError({
        status: 404,
        method: 'GET',
        path: `/api/stacks/${id}`,
        message: `Stack ${id} does not belong to this environment`,
      });
    }
    return stack;
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
    // a body nobody needed. A failure *reading* it is still reported — that is
    // the connection going, not an empty answer.
    const text = await this.readText(response, method, path);
    this.cache.invalidate(STACK_VOLATILE_KEYS);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  /**
   * Waits for a deploy that Portainer runs in the background.
   *
   * From Portainer 2.42 a stack update or redeploy answers at once with the
   * stack marked *deploying* and does the work afterwards; a create does the
   * same from 2.44. Reporting that answer as "deployed" told the operator a
   * stack was up while compose was still pulling, and a deploy that failed
   * was never reported at all. So a stack that answers as deploying is read
   * again until it settles, within the same write budget a synchronous deploy
   * had, and a stack that settles in error carries Portainer's reason.
   *
   * `startedAt` is when the write was sent, not when it was answered: the
   * budget covers the write and the settling together. Measured from the
   * answer instead, one stack write could hold its caller for twice the
   * configured budget — ten minutes at the default — which is not the budget
   * the operator set.
   *
   * Older Portainers never answer with the deploying status, so they pay one
   * check and nothing more.
   */
  private async awaitStackSettled(
    id: number,
    answered: unknown,
    path: string,
    startedAt: number,
  ): Promise<Stack | undefined> {
    // Only what Portainer said. A version that answers a write with nothing,
    // or with a body that is not a stack, has told us nothing about a
    // background deploy — because it does not run them — and asking again
    // would be a request per write for no answer.
    const first = asStack(answered);
    if (!first) return undefined;
    const deadline = startedAt + this.writeTimeoutMs;
    let current = first;
    while (current.Status === StackStatus.Deploying) {
      if (performance.now() > deadline) {
        throw new PortainerError({
          status: 504,
          method: 'GET',
          path,
          message: `Stack ${current.Name} is still deploying after ${Math.round(this.writeTimeoutMs / 1000)}s`,
          hint: 'Portainer is still working on it; check the stack in a moment',
        });
      }
      await sleep(STACK_SETTLE_POLL_MS);
      current = await this.stack(id);
    }
    if (current.Status === StackStatus.Error) {
      const reason = lastDeploymentMessage(current);
      throw new PortainerError({
        status: 502,
        method: 'GET',
        path,
        message: `Stack ${current.Name} failed to deploy${reason ? `: ${reason}` : ''}`,
        hint: 'fix the compose file or the image reference and deploy again',
        ...(reason ? { body: reason } : {}),
      });
    }
    this.cache.invalidate(STACK_VOLATILE_KEYS);
    return current;
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
    const path = `/api/stacks/${id}`;
    const startedAt = performance.now();
    const answered = await this.stackWrite('PUT', `${path}?${await this.endpointQuery()}`, {
      StackFileContent: update.content,
      Env: pairs(update.env ?? stack.Env ?? []),
      Prune: update.prune === true,
      PullImage: update.pullImage === true,
      // The name Portainer has used for the same flag since 2.36; both are
      // honoured, and sending both keeps the older name working on the
      // releases that only know it.
      RepullImageAndRedeploy: update.pullImage === true,
    });
    await this.awaitStackSettled(id, answered, path, startedAt);
    // Portainer's update handler clears AutoUpdate, and the request has no
    // field that could have kept it. Reported rather than swallowed: a webhook
    // that stops firing is otherwise discovered by it not firing.
    return { autoUpdateRemoved: Boolean(stack.AutoUpdate?.Webhook ?? stack.AutoUpdate?.Interval) };
  }

  /**
   * Sets, changes or turns off a git stack's auto-update.
   *
   * Only a git-backed stack can have one. Portainer accepts `AutoUpdate` on
   * its git create routes and nowhere else, and the route that changes it
   * afterwards refuses a stack with no repository config — with a 500 about
   * its own datastore, so the refusal is made here instead.
   *
   * That route rewrites a good deal more than auto-update. On every release
   * from 2.19 to the current one it assigns `ReferenceName`, `TLSSkipVerify`,
   * `Env`, the swarm prune option and the git credentials straight from the
   * payload, with no field meaning "leave that alone". A request that talked
   * only about auto-update would therefore blank the branch the stack tracks,
   * drop every environment variable it runs with, and delete the credentials
   * it clones with. Each is read off the stack and sent back unchanged; the
   * password is sent blank, which is how this API has always been told to keep
   * the one it holds.
   */
  async stackAutoUpdate(id: number, settings: StackAutoUpdate): Promise<StackAutoUpdateState> {
    const path = `/api/stacks/${id}/git`;
    const stack = await this.ownStack(id, 'POST', path);
    if (!stack.GitConfig?.URL) {
      throw new PortainerError({
        status: 400,
        method: 'POST',
        path,
        message: `Stack ${stack.Name} was not deployed from a repository`,
        hint: 'auto-update redeploys from git, so only a git-backed stack can have it',
      });
    }

    const interval = settings.interval?.trim() ?? '';
    if (interval !== '') {
      const every = intervalMs(interval);
      if (every === undefined) {
        throw new PortainerError({
          status: 400,
          method: 'POST',
          path,
          message: `"${interval}" is not an interval`,
          hint: 'hours, minutes and seconds, like 30m, 2h or 1h30m',
        });
      }
      if (every < MIN_AUTO_UPDATE_MS) {
        throw new PortainerError({
          status: 400,
          method: 'POST',
          path,
          message: `Polling every ${interval} is too often`,
          hint: 'a poll is a git fetch over this link; a minute is the shortest allowed',
        });
      }
    }

    // Kept rather than reissued: the URL is already configured wherever it
    // fires from, and turning polling on is no reason to break it. A new one
    // is minted only when the stack has none.
    const webhook =
      settings.webhook === true ? (stack.AutoUpdate?.Webhook ?? randomUUID()) : undefined;
    const wanted = interval !== '' || webhook !== undefined;
    const autoUpdate = wanted
      ? {
          ...(interval === '' ? {} : { Interval: interval }),
          ...(webhook === undefined ? {} : { Webhook: webhook }),
          ForceUpdate: settings.force === true,
          ForcePullImage: settings.pullImage === true,
        }
      : null;

    const stored = stack.GitConfig.Authentication ?? undefined;
    await this.stackWrite('POST', `${path}?${await this.endpointQuery()}`, {
      AutoUpdate: autoUpdate,
      Env: pairs(stack.Env ?? []),
      RepositoryReferenceName: stack.GitConfig.ReferenceName ?? '',
      TLSSkipVerify: stack.GitConfig.TLSSkipVerify === true,
      // Swarm rewrites the stack's own prune option from this; compose ignores
      // it. Either way it is the stack's current setting, not a new one.
      Prune: stack.Option?.Prune === true,
      RepositoryAuthentication: stored !== undefined,
      ...(stored ? { RepositoryUsername: stored.Username ?? '', RepositoryPassword: '' } : {}),
    });

    // No wait for the stack to settle, unlike the deploying writes: this one
    // stores settings and restarts the polling job. Nothing is redeployed, so
    // there is no container state to arrive.
    return {
      ...(interval === '' ? {} : { interval }),
      ...(webhook === undefined ? {} : { webhook }),
      pullImage: settings.pullImage === true,
      force: settings.force === true,
    };
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
    const path = `/api/stacks/${id}/git/redeploy`;
    // Credentials the stack was created with are asked for again by name.
    // Portainer keeps them, but through 2.42 it reuses them only when the
    // request says authentication is wanted and sends no password of its own
    // — so a redeploy that stayed silent about them cloned anonymously, and
    // every private repository failed with "unable to clone". A blank password
    // is the documented way to say "keep the stored one", on every release
    // from 2.17 to the Sources model of 2.43, which starts from the stored
    // credentials and only lets a non-empty password replace them.
    const stored = stack.GitConfig.Authentication ?? undefined;
    const authentication = options.authentication
      ? {
          RepositoryUsername: options.authentication.username,
          RepositoryPassword: options.authentication.password,
        }
      : stored
        ? { RepositoryUsername: stored.Username ?? '', RepositoryPassword: '' }
        : undefined;
    const startedAt = performance.now();
    const answered = await this.stackWrite('PUT', `${path}?${await this.endpointQuery()}`, {
      RepositoryReferenceName: stack.GitConfig.ReferenceName ?? '',
      RepositoryAuthentication: authentication !== undefined,
      ...(authentication ?? {}),
      Env: pairs(stack.Env ?? []),
      Prune: options.prune === true,
      PullImage: options.pullImage === true,
      RepullImageAndRedeploy: options.pullImage === true,
    });
    await this.awaitStackSettled(id, answered, path, startedAt);
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
    const path = `/api/stacks/create/${swarm ? 'swarm' : 'standalone'}/string`;
    const startedAt = performance.now();
    return this.createdStack(
      await this.stackWrite('POST', `${path}?${await this.endpointQuery()}`, {
        Name: stack.name,
        ...(swarm ? { SwarmID: swarmId } : {}),
        StackFileContent: stack.content,
        Env: pairs(stack.env ?? []),
      }),
      path,
      startedAt,
    );
  }

  /**
   * A create's answer, once the stack it describes has settled. A Portainer
   * that answers with no stack — older ones answered with the whole stack,
   * and that is what is relied on — is left as it answered.
   */
  private async createdStack(
    answered: unknown,
    path: string,
    startedAt: number,
  ): Promise<Stack | undefined> {
    const created = asStack(answered);
    if (!created) return undefined;
    return (await this.awaitStackSettled(created.Id, created, path, startedAt)) ?? created;
  }

  /** A new stack whose compose file lives in a git repository. */
  async createStackFromRepository(stack: StackFromRepository): Promise<Stack | undefined> {
    const { swarm, swarmId } = await this.swarmTarget('/api/stacks/create/{type}/repository');
    const path = `/api/stacks/create/${swarm ? 'swarm' : 'standalone'}/repository`;
    const startedAt = performance.now();
    return this.createdStack(
      await this.stackWrite('POST', `${path}?${await this.endpointQuery()}`, {
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
      }),
      path,
      startedAt,
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
   * Recreates a container, optionally from a freshly pulled image.
   *
   * Portainer's own operation rather than Docker's: Docker has no "recreate",
   * only remove and create, and Portainer's handler carries the container's
   * configuration, networks and volumes across for it. This is how a
   * container started by hand — outside any stack — is brought up to its
   * image's newest version. The container that comes back has a new id, so
   * every cached read that named the old one goes.
   *
   * Needs Portainer 2.19 or newer; the 404 an older one answers is said so.
   */
  async recreateContainer(
    containerId: string,
    options: { pullImage?: boolean } = {},
  ): Promise<DockerContainerInspect | undefined> {
    const environmentId = await this.environmentId();
    const path = `/api/docker/${environmentId}/containers/${encodeURIComponent(containerId)}/recreate`;
    let response: Response;
    try {
      response = await this.send(
        'POST',
        path,
        { json: { PullImage: options.pullImage === true }, timeoutMs: this.writeTimeoutMs },
        true,
      );
    } catch (cause) {
      if (cause instanceof PortainerError && cause.status === 404) {
        throw new PortainerError({
          status: 404,
          method: 'POST',
          path,
          message: 'Portainer did not offer the recreate operation',
          hint: 'recreating a container needs Portainer 2.19 or newer, and the container has to exist',
          ...(cause.body ? { body: cause.body } : {}),
        });
      }
      throw cause;
    }
    const text = await this.readText(response, 'POST', path);
    this.cache.invalidate([...CONTAINER_VOLATILE_KEYS, ...IMAGE_VOLATILE_KEYS, 'networks']);
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as DockerContainerInspect)
        : undefined;
    } catch {
      return undefined;
    }
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
    const agent = this.dispatcher;
    const report = (what: string, cause: unknown): void => {
      this.log(
        `dispatcher ${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    };
    // A graceful close waits for in-flight requests, and never finishes while
    // a response body is left unread — a deploy still answering at stop(), an
    // un-aborted stream. Given a moment, then torn down: a plugin that has
    // stopped should not hold a socket to Portainer for the life of the
    // process. Both rejections are caught: one surfacing during shutdown
    // would be an unhandled rejection, and Node ends Signal K on those.
    const destroy = (): void => {
      if (typeof agent.destroy !== 'function') return;
      agent.destroy().catch((cause: unknown) => report('destroy', cause));
    };
    const fallback = setTimeout(destroy, CLOSE_GRACE_MS);
    fallback.unref?.();
    agent
      .close()
      .then(() => clearTimeout(fallback))
      .catch((cause: unknown) => {
        clearTimeout(fallback);
        report('close', cause);
        destroy();
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
async function* readLogFrames(
  response: Response,
  onChunk?: (bytes: number) => void,
): AsyncIterable<LogFrame> {
  const body = response.body;
  if (!body) return;

  const demuxer = new LogDemuxer(multiplexedByContentType(response));
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        onChunk?.(value.byteLength);
        yield* demuxer.push(value);
      }
    }
    yield* demuxer.flush();
  } finally {
    // The caller's signal firing mid-read can leave cancel() rejecting, and a
    // rejection in a finally would mask whatever ended the loop.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The `X-Registry-Auth` header that names a registry without carrying a secret.
 *
 * Portainer's docker proxy intercepts `/images/create` (and any `…/push`),
 * decodes this header, and if it finds a `registryId` replaces the whole thing
 * with real credentials from its own store before Docker sees the request. So
 * this is a reference, not a credential: base64 here is Docker's transport
 * convention for the header, not protection.
 *
 * Id 0 is Docker Hub anonymously, which Portainer treats as a registry in its
 * own right.
 */
function registryAuthHeader(registryId: number): Record<string, string> {
  const named = JSON.stringify({ registryId });
  return { 'x-registry-auth': Buffer.from(named, 'utf8').toString('base64') };
}

/**
 * Docker's event stream, one JSON object per line, as they arrive.
 *
 * Nothing is buffered between lines: an event is acted on the moment its line
 * completes. A line that never completes is the unbounded case — the same one
 * the pull progress reader guards — so the buffer is capped and a stream that
 * runs past it ends rather than growing. An unparseable line is skipped: a
 * proxy that injects a keep-alive newline or a blank line is not a reason to
 * tear down a healthy subscription.
 */
async function* readEventLines(response: Response): AsyncIterable<DockerEvent> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let held = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) held += decoder.decode(value, { stream: true });
      for (let at = held.indexOf('\n'); at !== -1; at = held.indexOf('\n')) {
        const line = held.slice(0, at).trim();
        held = held.slice(at + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        // `null` parses, and a cast would not have caught it: the first read
        // of `.Type` on it throws, which would tear down a healthy stream over
        // one line a proxy wrote. Numbers and strings parse too, and are no
        // more an event than `null` is.
        if (typeof parsed !== 'object' || parsed === null) continue;
        yield parsed;
      }
      if (held.length > MAX_EVENT_LINE_BYTES) return;
    }
  } finally {
    // The caller's signal firing mid-read can leave cancel() rejecting, and a
    // rejection in a finally would mask whatever ended the loop.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Whether a log body is Docker's multiplexed framing, from the content type.
 *
 * Docker 23 and later say so on the response — `multiplexed-stream` for a
 * container without a TTY, `raw-stream` for one with — and Portainer's proxy
 * passes the header through. Older daemons say nothing, and the demuxer then
 * decides from the first bytes as it always did. Asking is better than
 * guessing: the guess withholds output until eight bytes have arrived, so a
 * TTY container that prints a short banner and goes quiet showed nothing.
 */
function multiplexedByContentType(response: Response): boolean | undefined {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('multiplexed-stream')) return true;
  if (type.includes('raw-stream')) return false;
  return undefined;
}

/** The most a one-shot log read may hold: `tail` bounds lines, this bounds bytes. */
const MAX_LOG_BYTES = 16 * 1024 * 1024;

/**
 * The most of one pull-progress line that is held before it is given up on.
 * Docker's are a few hundred bytes; only one is ever held at a time.
 */
const MAX_PULL_LINE_BYTES = 64 * 1024;

/** The same bound for an event line, which is smaller still. */
const MAX_EVENT_LINE_BYTES = 64 * 1024;

/** How often a deploying stack is asked whether it has settled. */
const STACK_SETTLE_POLL_MS = 2_000;

/** A deadline's abort reason, named so the transport hint calls it a timeout. */
function timeoutError(what: string, budgetMs: number): DOMException {
  return new DOMException(`Waited ${budgetMs} ms for ${what}`, 'TimeoutError');
}

/**
 * A pause that does not hold the process open. The timer is unreferenced
 * because a settle poll waiting on Portainer must never be the reason Signal K
 * refuses to exit.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * A body that was supposed to be JSON, or a failure that says what it was
 * instead. A captive portal, a reverse proxy's login page, or a base URL that
 * points at Portainer's own web page all answer 200 with HTML; parsed
 * blindly, that was a bare SyntaxError with no hint, and the facade answered
 * 500 with "Unexpected token '<'".
 */
function parseJsonBody<T>(text: string, res: Response, method: string, path: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const type = res.headers.get('content-type') ?? '';
    const looksLikeHtml = text.trimStart().startsWith('<') || type.includes('html');
    throw new PortainerError({
      status: 502,
      method,
      path,
      message: `Portainer ${method} ${path} answered with something that is not JSON`,
      hint: looksLikeHtml
        ? 'this looks like a web page rather than the API — check the base URL, and whether a login page or captive portal is answering instead of Portainer'
        : 'the answer could not be parsed — check the base URL points at Portainer itself',
      body: redactValue(text.slice(0, 500)),
    });
  }
}

/**
 * How long a JWT says it is good for, from its `exp` claim, in milliseconds
 * from now. The signature is not checked — Portainer issued it a moment ago
 * — and a token without a readable claim simply has no answer.
 */
export function jwtLifetimeMs(token: string, nowMs = Date.now()): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return undefined;
    return claims.exp * 1000 - nowMs;
  } catch {
    return undefined;
  }
}

/** Portainer's last word on a deploy that ran in the background. */
function lastDeploymentMessage(stack: Stack): string | undefined {
  const entries = Array.isArray(stack.DeploymentStatus) ? stack.DeploymentStatus : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.Message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

/**
 * An image reference split into what `POST /images/create` wants: the name in
 * `fromImage` and the tag — or digest — in `tag`. The last colon after the
 * last slash is the tag separator, so a registry port is not mistaken for
 * one: `registry.local:5000/ais-logger` has no tag, `…/ais-logger:1.4` does.
 */
export function splitImageReference(reference: string): { name: string; tag?: string } {
  const trimmed = reference.trim();
  const at = trimmed.indexOf('@');
  if (at > 0) return { name: trimmed.slice(0, at), tag: trimmed.slice(at + 1) };
  const lastSlash = trimmed.lastIndexOf('/');
  const colon = trimmed.lastIndexOf(':');
  if (colon > lastSlash) return { name: trimmed.slice(0, colon), tag: trimmed.slice(colon + 1) };
  return { name: trimmed };
}

/**
 * An image reference as path: each segment encoded, the slashes kept, and the
 * tag separator left as the colon it is.
 *
 * Docker's own route takes the whole rest of the path as the image name, so
 * `ghcr.io/owner/app:1.2` travels exactly as it is written. Encoding the
 * slashes as %2F instead is what Portainer's proxy refuses outright — it
 * rejects any proxied path carrying an encoded separator — and Docker would
 * have read them as part of the name rather than as path anyway.
 */
function encodeImageReference(reference: string): string {
  const segments = reference.split('/');
  // The slashes are kept as slashes, so a `..` among them is a path segment
  // the URL parser will act on: `images/../../../stacks/3` resolves to
  // `/api/stacks/3`, and the DELETE meant for an image deletes a stack
  // instead, past every guard the stack routes have. Docker has no image
  // whose name contains such a segment, so refusing them costs nothing.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new PortainerError({
      status: 400,
      method: 'DELETE',
      path: '/images',
      message: `"${reference}" is not an image reference`,
      hint: 'an image is named by its id, or by repository/name with an optional tag',
    });
  }
  return segments.map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/');
}

/**
 * Whether this plugin can manage an environment, and why not when it cannot.
 *
 * The plugin speaks to Docker through Portainer's proxy. A Kubernetes or
 * Azure environment has no Docker behind it, and an Edge agent in async mode
 * has no tunnel for the proxy to use — Portainer answers every such call
 * with an error about a manifest or a tunnel that says nothing an operator
 * can act on. Said here instead, once, in the picker.
 */
export function environmentSupport(environment: Environment): EnvironmentSupport {
  switch (environment.Type) {
    case EnvironmentType.AzureACI:
      return { supported: false, reason: 'Azure ACI environments have no Docker API to manage' };
    case EnvironmentType.LocalKubernetes:
    case EnvironmentType.AgentOnKubernetes:
    case EnvironmentType.EdgeAgentOnKubernetes:
      return { supported: false, reason: 'Kubernetes environments are not managed by this plugin' };
    case EnvironmentType.EdgeAgentOnDocker:
      if (environment.Edge?.AsyncMode) {
        return {
          supported: false,
          reason:
            'an Edge agent in async mode cannot be reached through the Docker proxy; Portainer manages it with Edge stacks only',
        };
      }
      return { supported: true };
    default:
      return { supported: true };
  }
}

/**
 * The read budget a standard-mode Edge environment needs, or none for a
 * direct one. Portainer opens the tunnel on demand and waits up to two
 * check-in intervals for the agent to raise it, and the request that asked
 * waits with it.
 */
function edgeReadBudgetMs(environment: Environment): number | undefined {
  if (environment.Type !== EnvironmentType.EdgeAgentOnDocker) return undefined;
  const interval =
    environment.EdgeCheckinInterval && environment.EdgeCheckinInterval > 0
      ? environment.EdgeCheckinInterval
      : EDGE_DEFAULT_INTERVAL_SECONDS;
  return (2 * interval + EDGE_GRACE_SECONDS) * 1000;
}

/**
 * Docker's stats sample, reduced to the figures an operator reads.
 *
 * The CPU share follows Docker's own arithmetic: the container's CPU time
 * over the host's between the two samples, scaled by the number of CPUs.
 * Every field is optional in the raw answer — a container that just exited,
 * a cgroup v1 host, a daemon without the network namespace — so anything that
 * cannot be computed is left out rather than reported as NaN.
 */
export function summarizeStats(raw: DockerContainerStats): ContainerStats {
  const summary: ContainerStats = {};
  if (typeof raw?.read === 'string') summary.read = raw.read;

  const cpu = raw?.cpu_stats;
  const previous = raw?.precpu_stats;
  const cpuTotal = cpu?.cpu_usage?.total_usage;
  const cpuPrevious = previous?.cpu_usage?.total_usage;
  const systemTotal = cpu?.system_cpu_usage;
  const systemPrevious = previous?.system_cpu_usage;
  if (
    isFiniteNumber(cpuTotal) &&
    isFiniteNumber(cpuPrevious) &&
    isFiniteNumber(systemTotal) &&
    isFiniteNumber(systemPrevious)
  ) {
    const cpuDelta = cpuTotal - cpuPrevious;
    const systemDelta = systemTotal - systemPrevious;
    const cpus = isFiniteNumber(cpu?.online_cpus)
      ? cpu.online_cpus
      : (cpu?.cpu_usage?.percpu_usage?.length ?? 1);
    if (systemDelta > 0 && cpuDelta >= 0) {
      summary.cpuPercent = round((cpuDelta / systemDelta) * Math.max(1, cpus) * 100);
    }
  }

  const memory = raw?.memory_stats;
  if (isFiniteNumber(memory?.usage)) {
    // cgroup v1 counts the page cache in `usage` and reports it in
    // `stats.cache`; cgroup v2 reports `inactive_file` instead. Docker's own
    // `docker stats` subtracts whichever is there, and so does this.
    const cache = isFiniteNumber(memory.stats?.inactive_file)
      ? memory.stats.inactive_file
      : isFiniteNumber(memory.stats?.cache)
        ? memory.stats.cache
        : 0;
    summary.memoryBytes = Math.max(0, memory.usage - cache);
    if (isFiniteNumber(memory.limit) && memory.limit > 0) {
      summary.memoryLimitBytes = memory.limit;
      summary.memoryPercent = round((summary.memoryBytes / memory.limit) * 100);
    }
  }

  const networks = raw?.networks;
  if (networks && typeof networks === 'object') {
    let rx = 0;
    let tx = 0;
    for (const network of Object.values(networks)) {
      if (isFiniteNumber(network?.rx_bytes)) rx += network.rx_bytes;
      if (isFiniteNumber(network?.tx_bytes)) tx += network.tx_bytes;
    }
    summary.networkRxBytes = rx;
    summary.networkTxBytes = tx;
  }

  const io = raw?.blkio_stats?.io_service_bytes_recursive;
  if (Array.isArray(io)) {
    let read = 0;
    let write = 0;
    for (const entry of io) {
      if (!isFiniteNumber(entry?.value)) continue;
      const op = String(entry.op ?? '').toLowerCase();
      if (op === 'read') read += entry.value;
      else if (op === 'write') write += entry.value;
    }
    summary.blockReadBytes = read;
    summary.blockWriteBytes = write;
  }

  if (isFiniteNumber(raw?.pids_stats?.current)) summary.pids = raw.pids_stats.current;
  return summary;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
