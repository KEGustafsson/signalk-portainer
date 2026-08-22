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

export async function apiGet<T>(path: string, instance?: string, signal?: AbortSignal): Promise<T> {
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : '';
  const response = await fetch(`${BASE}${path}${query}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });

  const body: unknown = await response.json().catch(() => ({}));

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
