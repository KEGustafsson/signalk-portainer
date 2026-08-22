/**
 * Credentials must never reach a log line or an HTTP response body. Everything
 * that leaves the plugin passes through here.
 */

const TOKEN_PATTERNS: readonly RegExp[] = [
  /ptr_[A-Za-z0-9+/=_-]+/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.+/=-]*/g,
];

const SECRET_KEYS = new Set([
  'apikey',
  'password',
  'jwt',
  'token',
  'authorization',
  'x-api-key',
  'cacert',
]);

/** Replaces anything that looks like a credential in free text. */
export function redactText(input: string): string {
  return TOKEN_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[redacted]'), input);
}

/**
 * Deep-copies a value with secret-looking keys replaced. Used on every facade
 * response and on anything handed to the debug logger.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase())
        ? item === '' || item === undefined || item === null
          ? item
          : '[redacted]'
        : redactValue(item);
    }
    return out as unknown as T;
  }
  return value;
}
