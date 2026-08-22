/** Presentation helpers. Kept separate so they can be tested without a DOM. */

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
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

export function shortId(id: string | undefined, length = 12): string {
  if (!id) return '—';
  return id.replace(/^sha256:/, '').slice(0, length);
}
