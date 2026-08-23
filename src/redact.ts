/**
 * Credentials must never reach a log line or an HTTP response body. Everything
 * that leaves the plugin passes through here.
 */

const TOKEN_PATTERNS: readonly RegExp[] = [
  /ptr_[A-Za-z0-9+/=_-]+/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.+/=-]*/g,
];

/**
 * Compared after lowercasing and stripping `_` and `-`, so `apiKey`, `api_key`,
 * `api-key` and `X-API-Key` all collapse onto the same entry.
 *
 * `ca` and `servername` are deliberately absent: a CA certificate is public
 * material and masking it would hide useful diagnostic detail.
 */
const SECRET_KEYS = new Set([
  'apikey',
  'xapikey',
  'apitoken',
  'accesstoken',
  'refreshtoken',
  'password',
  'passwd',
  'secret',
  'jwt',
  'token',
  'authorization',
  'cookie',
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

/** True for `{}` literals and null-prototype objects, false for Date, Map, Error, Buffer… */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Replaces anything that looks like a credential in free text. */
export function redactText(input: string): string {
  return TOKEN_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[redacted]'), input);
}

/**
 * Deep-copies a value with secret-looking keys replaced. Used on every facade
 * response and on anything handed to the debug logger.
 *
 * Non-plain objects (Date, Map, Set, Error, Buffer) are passed through rather
 * than rebuilt from their entries, which would silently reduce them to `{}`.
 * Cycles are broken rather than followed.
 */
export function redactValue<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  const object = value as unknown as object;
  if (seen.has(object)) return '[circular]' as unknown as T;

  if (Array.isArray(value)) {
    seen.add(object);
    const items = value.map((item) => redactValue(item, seen)) as unknown as T;
    // Dropped again on the way out: `seen` is the path from the root, not every
    // object ever visited. Left in, it detects repetition rather than cycles,
    // and one object referenced twice — the same container listed under two
    // keys, the same row in a list — comes out as "[circular]" the second time.
    seen.delete(object);
    return items;
  }

  if (!isPlainObject(object)) return value;

  seen.add(object);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key)
      ? item === '' || item === undefined || item === null
        ? item
        : '[redacted]'
      : redactValue(item, seen);
  }
  seen.delete(object);
  return out as unknown as T;
}
