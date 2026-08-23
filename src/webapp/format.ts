/** Presentation helpers. Kept separate so they can be tested without a DOM. */

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count, scaled.
 *
 * The type says `number | undefined`, but the value arrives through an
 * unchecked cast of whatever Portainer answered with: a string, a null, or an
 * Infinity from a daemon that could not measure something all reach here. So
 * the guard is a runtime one — anything that is not a finite number renders as
 * the placeholder rather than as "null B", "Infinity TB", or a TypeError from
 * `.toFixed` that takes the whole table down mid-render.
 */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  // Scaled on the magnitude and signed afterwards: a negative size is a
  // Portainer bug rather than a real reading, but "-5000000000 B" hides that
  // it is one, because the early return below catches every negative before
  // the loop can scale it.
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  if (value < 1000) return `${sign}${value} B`;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${sign}${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

/** Docker reports epoch seconds; the admin UI wants something readable. */
export function formatAge(epochSeconds: number | undefined, now = Date.now()): string {
  if (!epochSeconds) return '—';
  const seconds = Math.max(0, Math.floor(now / 1000 - epochSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Docker container names arrive as ["/name"]; show the readable one. */
export function containerName(names: string[] | undefined): string {
  const first = names?.[0];
  if (!first) return '—';
  return first.startsWith('/') ? first.slice(1) : first;
}

/** Bootstrap badge colour for a Docker container state. */
export function stateColour(state: string): string {
  switch (state) {
    case 'running':
      return 'success';
    case 'restarting':
    case 'created':
      return 'warning';
    case 'exited':
    case 'dead':
      return 'danger';
    default:
      return 'secondary';
  }
}

/**
 * Bootstrap badge colour for an environment's health. "unknown" is Portainer
 * declining to say — an environment it has not snapshotted yet, say — so it
 * gets the neutral badge rather than the red one that means "down".
 */
export function healthColour(health: string): string {
  switch (health) {
    case 'up':
      return 'success';
    case 'down':
      return 'danger';
    default:
      return 'secondary';
  }
}

export function shortId(id: string | undefined, length = 12): string {
  if (!id) return '—';
  return id.replace(/^sha256:/, '').slice(0, length);
}
