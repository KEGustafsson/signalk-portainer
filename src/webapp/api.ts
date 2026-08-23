/**
 * Calls to the plugin's own facade. Signal K authenticates these with its
 * HttpOnly session cookie, which the browser attaches when the request is made
 * with `credentials: 'include'` — the panel never handles a token itself.
 */

const BASE = '/plugins/signalk-portainer/api';

export class ApiError extends Error {
  readonly status: number;
  readonly hint: string | undefined;

  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.hint = hint;
  }
}

interface FacadeError {
  error?: string;
  hint?: string;
}

/**
 * The full URL for a facade path, with the instance attached.
 *
 * Exported because an EventSource takes a URL rather than going through
 * `fetch`, and the two must agree about how the instance is attached.
 */
export function apiUrl(path: string, instance?: string): string {
  // Some paths already carry a query (?all=true, ?force=true), so the separator
  // has to be chosen rather than assumed — appending a second '?' makes the
  // facade ignore the instance and silently serve the default one.
  const separator = path.includes('?') ? '&' : '?';
  const query = instance ? `${separator}instance=${encodeURIComponent(instance)}` : '';
  return `${BASE}${path}${query}`;
}

/**
 * How long any one request may take before the panel gives up on it.
 *
 * A read heals itself — the poll aborts its predecessor every ten seconds —
 * but a mutation has nothing behind it: the row's buttons stay disabled while
 * the browser waits out its own TCP timeout, which is minutes, and the
 * operator is shown neither an error nor a way to try again.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The signal a request runs under: the caller's, with a deadline attached.
 *
 * `AbortSignal.any` and `AbortSignal.timeout` are recent enough that a browser
 * without them is plausible, and the panel is served to whatever the operator
 * is holding — so the pair is assembled by hand when they are missing, rather
 * than the deadline being dropped on exactly the old browser most likely to
 * need it.
 */
interface Deadline {
  signal: AbortSignal;
  /** True when it was the deadline that fired, not the caller. */
  expired: () => boolean;
  release: () => void;
}

function withDeadline(caller: AbortSignal | undefined): Deadline {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
  const expired = (): boolean => deadline.signal.aborted && caller?.aborted !== true;

  if (!caller) {
    return { signal: deadline.signal, expired, release: () => clearTimeout(timer) };
  }
  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([caller, deadline.signal]),
      expired,
      release: () => clearTimeout(timer),
    };
  }
  const forward = (): void => deadline.abort();
  if (caller.aborted) deadline.abort();
  else caller.addEventListener('abort', forward, { once: true });
  return {
    signal: deadline.signal,
    expired,
    release: () => {
      clearTimeout(timer);
      caller.removeEventListener('abort', forward);
    },
  };
}

async function request<T>(
  method: string,
  path: string,
  instance?: string,
  signal?: AbortSignal,
  payload?: unknown,
): Promise<T> {
  const deadline = withDeadline(signal);
  try {
    return await send<T>(method, path, instance, payload, deadline);
  } finally {
    // Released only once the body has been read. `fetch` resolves as soon as
    // the headers arrive, so clearing the timer here rather than after the
    // response was fully consumed left a stalled body with no deadline at all
    // — the row would stay disabled with no error, which is the failure this
    // deadline exists to prevent.
    deadline.release();
  }
}

function timedOut(): ApiError {
  return new ApiError(
    0,
    `The request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`,
    'Signal K did not answer — the connection may have dropped. Check the server is reachable, then try again.',
  );
}

async function send<T>(
  method: string,
  path: string,
  instance: string | undefined,
  payload: unknown,
  deadline: Deadline,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path, instance), {
      method,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: deadline.signal,
    });
  } catch (cause) {
    // Told apart from the caller's own abort, which is the panel replacing one
    // read with the next and not something to report.
    if (deadline.expired()) throw timedOut();
    throw cause;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // The body is read under the same deadline as the headers: a server that
    // answers and then stalls mid-body is the case that hangs longest.
    if (deadline.expired()) throw timedOut();
    if (cause instanceof Error && cause.name === 'AbortError') throw cause;
    if (response.ok) {
      // A 200 that is not JSON means something answered instead of the plugin —
      // a proxy, or a login page. Falling back to {} would render an empty
      // table, which reads as "nothing here" rather than "something is wrong".
      throw new ApiError(
        response.status,
        'The response was not JSON',
        'a proxy or login page may have answered instead of the plugin',
      );
    }
    body = {};
  }

  if (!response.ok) {
    const failure = body as FacadeError;
    throw new ApiError(
      response.status,
      failure.error ?? `Request failed with ${response.status}`,
      failure.hint,
    );
  }

  return body as T;
}

export async function apiGet<T>(path: string, instance?: string, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', path, instance, signal);
}

/**
 * A state-changing call. Separate from apiGet so a mutation is never issued by
 * a path that reads like a read, and so every call site has to name its method.
 */
export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  instance?: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  return request<T>(method, path, instance, signal, body);
}
