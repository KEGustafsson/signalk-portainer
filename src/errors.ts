import { redactText } from './redact';

export type AuthMode = 'apiKey' | 'userPass';

/**
 * Every Portainer failure surfaces as one of these, carrying an actionable
 * hint rather than a bare status code. The hints encode the mistakes that
 * docs/portainer-api.md calls out as the common ones.
 */
export class PortainerError extends Error {
  /** 0 for transport failures that never reached Portainer. */
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly hint: string | undefined;
  readonly body: string | undefined;

  constructor(opts: {
    status: number;
    method: string;
    path: string;
    message: string;
    hint?: string;
    body?: string;
  }) {
    super(opts.hint ? `${opts.message} — ${opts.hint}` : opts.message);
    this.name = 'PortainerError';
    this.status = opts.status;
    this.method = opts.method;
    this.path = opts.path;
    this.hint = opts.hint;
    this.body = opts.body;
  }

  /** Maps to the HTTP status the facade should return to the browser. */
  get facadeStatus(): number {
    if (this.status === 0) return 502;
    if (this.status === 401 || this.status === 403) return 502;
    return this.status;
  }

  static hintFor(status: number, authMode: AuthMode): string | undefined {
    switch (status) {
      case 400:
        return 'a required query parameter or body field is missing or malformed';
      case 401:
        return authMode === 'apiKey'
          ? 'the API token was rejected. A ptr_ token belongs in the X-API-Key header, never in Authorization: Bearer'
          : 'the username/password was rejected, or the cached JWT expired and could not be renewed';
      case 403:
        return 'the credential is valid but its Portainer role lacks permission for this resource';
      case 404:
        return 'wrong environment id (ids are creation-order, not names), or an endpoint that only exists in Portainer EE';
      case 409:
        return 'conflict — the resource already exists or is in an incompatible state';
      default:
        return undefined;
    }
  }

  static async fromResponse(
    res: { status: number; text(): Promise<string> },
    method: string,
    path: string,
    authMode: AuthMode,
  ): Promise<PortainerError> {
    let body: string | undefined;
    try {
      body = redactText((await res.text()).slice(0, 500)) || undefined;
    } catch {
      body = undefined;
    }
    return new PortainerError({
      status: res.status,
      method,
      path,
      message: `Portainer ${method} ${path} failed with ${res.status}`,
      hint: PortainerError.hintFor(res.status, authMode),
      body,
    });
  }

  static fromTransport(
    cause: unknown,
    method: string,
    path: string,
    baseUrl: string,
  ): PortainerError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new PortainerError({
      status: 0,
      method,
      path,
      message: `Portainer ${method} ${path} could not be reached`,
      hint: isTimeoutCause(cause)
        ? `no response from ${baseUrl} before the configured timeout`
        : `check host, port and protocol for ${baseUrl}; for a self-signed certificate supply its CA or clear rejectUnauthorized (${redactText(detail)})`,
    });
  }
}

/**
 * `AbortSignal.timeout()` surfaces as a TimeoutError, but fetch wraps it in a
 * generic "fetch failed" TypeError — so the name has to be read from the cause
 * chain, not from the outermost message, or a timeout gets the TLS hint.
 */
function isTimeoutCause(cause: unknown, depth = 0): boolean {
  if (depth > 5 || !(cause instanceof Error)) return false;
  if (cause.name === 'TimeoutError' || cause.name === 'AbortError') return true;
  const message = cause.message.toLowerCase();
  if (message.includes('timeout') || message.includes('aborted')) return true;
  return isTimeoutCause((cause as { cause?: unknown }).cause, depth + 1);
}
