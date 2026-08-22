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

async function request<T>(
  method: string,
  path: string,
  instance?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(apiUrl(path, instance), {
    method,
    credentials: 'include',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
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
  method: 'POST' | 'DELETE',
  path: string,
  instance?: string,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(method, path, instance, signal);
}
