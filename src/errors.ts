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
    /** The transport failure this wraps, kept so `err.code` and its stack survive. */
    cause?: unknown;
  }) {
    // The cause is passed only when there is one: `{ cause: undefined }` still
    // creates the property, which makes a constructed error look like a wrapped
    // one to anything walking the chain.
    super(
      opts.hint ? `${opts.message} — ${opts.hint}` : opts.message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
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
    // A 304 must never leave here: the browser treats it as "use your cache"
    // and drops the body, so a JSON error payload sent with it is invisible.
    // The lifecycle callers already claim Docker's 304 as success, so one
    // reaching this point is a bug rather than a state the operator caused.
    if (this.status === 304) return 500;
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
    // Portainer's own sentence is the only text that says what went wrong — "a
    // stack with the name nav already exists", "yaml: line 5: did not find
    // expected key" — so it goes into the message rather than staying in a
    // field nothing reads.
    const detail = upstreamDetail(body);
    return new PortainerError({
      status: res.status,
      method,
      path,
      message: `Portainer ${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ''}`,
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
    const detail = redactText(cause instanceof Error ? cause.message : String(cause));
    const code = causeCode(cause);
    const tls = code ? TLS_HINTS[code] : undefined;
    const transport = code ? TRANSPORT_HINTS[code] : undefined;

    let hint: string;
    switch (abortKind(cause)) {
      case 'deadline':
        hint = `no response from ${baseUrl} before the configured timeout`;
        break;
      case 'abort':
        // A caller-initiated abort, not a deadline: a closed log stream or a
        // shutdown. Telling the operator their Portainer is slow would send
        // them looking for a fault that is not there.
        hint = `the request to ${baseUrl} was cancelled before it finished`;
        break;
      default:
        hint = tls
          ? `${tls} (${detail})`
          : transport
            ? `${transport} — ${baseUrl} (${detail})`
            : `check host, port and protocol for ${baseUrl}; for a self-signed certificate supply its CA or clear rejectUnauthorized (${detail})`;
    }

    return new PortainerError({
      status: 0,
      method,
      path,
      message: `Portainer ${method} ${path} could not be reached`,
      hint,
      cause,
    });
  }
}

/** How long a quoted upstream sentence may be before it stops being a hint. */
const MAX_DETAIL = 200;

/**
 * Portainer's explanation, dug out of the error body it answered with.
 *
 * Portainer answers `{"message":"…","details":"…"}` and the Docker proxy passes
 * `{"message":"…"}` through; anything else is left alone. An HTML page comes
 * from a reverse proxy in front of Portainer rather than from Portainer, and a
 * body that does not parse was truncated at 500 characters, so neither is
 * quoted back at the operator as if it were an answer.
 */
function upstreamDetail(body: string | undefined): string | undefined {
  const text = body?.trim();
  if (!text) return undefined;

  let candidate = text;
  if (text.startsWith('{')) {
    let parsed: { message?: unknown; details?: unknown };
    try {
      parsed = JSON.parse(text) as { message?: unknown; details?: unknown };
    } catch {
      return undefined;
    }
    // Portainer repeats the same sentence in both fields as often as not.
    const fields = [...new Set([parsed.message, parsed.details])].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (fields.length === 0) return undefined;
    candidate = fields.map((field) => field.trim()).join(': ');
  } else if (text.startsWith('<')) {
    return undefined;
  }

  return candidate.length > MAX_DETAIL ? `${candidate.slice(0, MAX_DETAIL)}…` : candidate;
}

/**
 * Socket-level failures, by the code Node reports, and what each one means for
 * the operator.
 *
 * Split from the certificate failures deliberately: a host name with a typo in
 * it used to be answered with advice about supplying a CA certificate, which
 * sends the operator to a setting that has nothing to do with the fault.
 */
const TRANSPORT_HINTS: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'nothing is listening on that port — check the port, and that Portainer is running',
  ENOTFOUND: 'the host name does not resolve — check it for a typo',
  EAI_AGAIN: 'the host name could not be resolved right now — the DNS server did not answer',
  EHOSTUNREACH: 'no route to that host from here',
  ENETUNREACH: 'no route to that network from here',
  ECONNRESET:
    'the connection was closed before an answer arrived — an https URL against a plain-http port does this',
  EPIPE: 'the connection was closed while the request was still being sent',
};

/** Where supplying a CA, or a servername, is the fix. */
const CA_HINT =
  'the certificate could not be verified — supply its CA, or clear rejectUnauthorized for a self-signed one';

const TLS_HINTS: Readonly<Record<string, string>> = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: CA_HINT,
  DEPTH_ZERO_SELF_SIGNED_CERT: CA_HINT,
  SELF_SIGNED_CERT_IN_CHAIN: CA_HINT,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: CA_HINT,
  CERT_HAS_EXPIRED: 'the certificate has expired — renew it, or check this host’s clock',
  ERR_TLS_CERT_ALTNAME_INVALID:
    'the certificate was not issued for that host name — set servername to the name it carries',
};

/** The first `code` on the cause chain; fetch wraps the real failure twice. */
function causeCode(cause: unknown, depth = 0): string | undefined {
  if (depth > 5 || !(cause instanceof Error)) return undefined;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return causeCode((cause as { cause?: unknown }).cause, depth + 1);
}

/** Deadline codes undici raises for its own read and connect budgets. */
const DEADLINE_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
]);

/**
 * Why the request ended, when it ended before an answer.
 *
 * `AbortSignal.timeout()` surfaces as a TimeoutError and a caller's abort as an
 * AbortError, but fetch wraps both in a generic "fetch failed" TypeError — so
 * the name has to be read from the cause chain, not the outermost message.
 * Names and codes only: matching the word "timeout" in message text reports
 * every failure against a host named `timeouts.lan` as a timeout.
 */
function abortKind(cause: unknown, depth = 0): 'deadline' | 'abort' | undefined {
  if (depth > 5 || !(cause instanceof Error)) return undefined;
  const code = (cause as { code?: unknown }).code;
  if (cause.name === 'TimeoutError' || (typeof code === 'string' && DEADLINE_CODES.has(code))) {
    return 'deadline';
  }
  if (cause.name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') {
    return 'abort';
  }
  return abortKind((cause as { cause?: unknown }).cause, depth + 1);
}

/**
 * The plugin itself refusing an operation — control disabled, destructive
 * operations disabled, or the target being the Signal K container.
 *
 * Deliberately not a PortainerError: that type maps an upstream 403 to 502,
 * because Portainer refusing the plugin is a gateway problem rather than the
 * browser's. A policy refusal is the opposite — it is exactly the browser's
 * 403 and must reach it unchanged.
 */
export class PolicyError extends Error {
  readonly status = 403;
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'PolicyError';
    this.hint = hint;
  }
}
