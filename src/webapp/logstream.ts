/**
 * The parts of the log viewer that do not need a DOM.
 *
 * The viewer itself is a React component with a scroll pane and an EventSource;
 * everything it decides — which URL to ask for, what to make of the answer, how
 * much to keep — lives here, where it can be tested without either.
 */

export type LogStreamName = 'stdout' | 'stderr';

export interface LogLine {
  stream: LogStreamName;
  text: string;
}

export interface LogQuery {
  /** How many lines of history to start from. */
  tail: number;
  /** Only lines newer than this many seconds ago; 0 for all history. */
  sinceSeconds: number;
  timestamps: boolean;
}

/**
 * The one-shot choices, matching the server's clamp: it defaults to 200 and
 * refuses more than 5000 however large a number is asked for.
 */
export const TAIL_CHOICES = [100, 200, 1000, 5000] as const;

export const SINCE_CHOICES: { label: string; seconds: number }[] = [
  { label: 'All history', seconds: 0 },
  { label: 'Last 15 minutes', seconds: 15 * 60 },
  { label: 'Last hour', seconds: 60 * 60 },
  { label: 'Last 24 hours', seconds: 24 * 60 * 60 },
];

export const DEFAULT_QUERY: LogQuery = { tail: 200, sinceSeconds: 0, timestamps: false };

/**
 * How many lines the viewer keeps.
 *
 * A container writing steadily would otherwise grow the DOM without bound while
 * a tab sits open on it, and the browser is the one machine in this system with
 * no memory to spare — the panel runs on whatever the operator is holding.
 */
export const MAX_LINES = 5000;

/** The facade path for a read, one-shot or streaming. `since` is absolute. */
export function logPath(id: string, query: LogQuery, follow: boolean, now = Date.now()): string {
  const params = new URLSearchParams({ tail: String(query.tail) });
  if (query.sinceSeconds > 0) {
    params.set('since', String(Math.floor(now / 1000) - query.sinceSeconds));
  }
  if (query.timestamps) params.set('timestamps', 'true');
  return `/containers/${encodeURIComponent(id)}/logs${follow ? '/stream' : ''}?${params.toString()}`;
}

/** One line from an untrusted shape, or undefined if there is no line in it. */
export function normalizeLine(value: unknown): LogLine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { stream?: unknown; text?: unknown };
  if (typeof candidate.text !== 'string') return undefined;
  // Anything that is not explicitly stderr is shown as ordinary output rather
  // than coloured as an error: over-reporting errors is the worse mistake.
  return { stream: candidate.stream === 'stderr' ? 'stderr' : 'stdout', text: candidate.text };
}

/**
 * The lines in a one-shot response.
 *
 * The panel runs inside someone else's admin UI and the body is whatever came
 * back over the network, so a missing or misshapen field renders as no lines
 * rather than as a crash inside the modal.
 */
export function normalizeLines(body: unknown): LogLine[] {
  if (typeof body !== 'object' || body === null) return [];
  const lines = (body as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return [];
  return lines.map(normalizeLine).filter((line): line is LogLine => line !== undefined);
}

/** The payload of one SSE `data:` field, if it carries a line. */
export function parseLineEvent(data: string): LogLine | undefined {
  try {
    return normalizeLine(JSON.parse(data));
  } catch {
    // A frame that is not JSON is not a line. Dropping it is better than
    // rendering the raw frame, which would look like output the container wrote.
    return undefined;
  }
}

/** Appends, dropping the oldest lines once the buffer is full. */
export function appendLines(
  existing: readonly LogLine[],
  incoming: readonly LogLine[],
  max = MAX_LINES,
): LogLine[] {
  if (incoming.length === 0) return existing as LogLine[];
  const joined = [...existing, ...incoming];
  return joined.length <= max ? joined : joined.slice(joined.length - max);
}

/** The buffer as a text file: what an operator would paste into a bug report. */
export function toText(lines: readonly LogLine[]): string {
  if (lines.length === 0) return '';
  return `${lines.map((line) => (line.stream === 'stderr' ? `[stderr] ${line.text}` : line.text)).join('\n')}\n`;
}

/** A filename that says which container, which instance and when. */
export function downloadName(name: string, instance: string | undefined, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (
    [safe(instance ?? ''), safe(name) || 'container', stamp].filter(Boolean).join('-') + '.log'
  );
}

/** Whether the browser can follow a stream at all. */
export function canFollow(): boolean {
  return typeof EventSource !== 'undefined';
}
