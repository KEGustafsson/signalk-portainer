import {
  MAX_LINES,
  appendLines,
  canFollow,
  downloadName,
  logPath,
  normalizeLine,
  normalizeLines,
  parseLineEvent,
  toText,
  type BufferedLine,
  type LogLine,
} from '../../src/webapp/logstream';

/** A fixed clock, so `since` is an assertion rather than an approximation. */
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

const query = (overrides: Partial<Parameters<typeof logPath>[1]> = {}) => ({
  tail: 200,
  sinceSeconds: 0,
  timestamps: false,
  ...overrides,
});

describe('logPath', () => {
  it('asks for a bounded read', () => {
    expect(logPath('abc123', query(), false, NOW)).toBe('/containers/abc123/logs?tail=200');
  });

  it('follows on a different route, so the one-shot read is never a stream', () => {
    expect(logPath('abc123', query(), true, NOW)).toBe('/containers/abc123/logs/stream?tail=200');
  });

  it('turns a relative window into the absolute second Docker wants', () => {
    const path = logPath('abc123', query({ sinceSeconds: 900 }), false, NOW);

    expect(path).toContain(`since=${Math.floor(NOW / 1000) - 900}`);
  });

  it('leaves since out entirely when all history is wanted', () => {
    expect(logPath('abc123', query({ sinceSeconds: 0 }), false, NOW)).not.toContain('since');
  });

  it('carries timestamps only when they are asked for', () => {
    expect(logPath('abc', query({ timestamps: true }), false, NOW)).toContain('timestamps=true');
    expect(logPath('abc', query(), false, NOW)).not.toContain('timestamps');
  });

  it('encodes the id rather than pasting it into the path', () => {
    // Not a realistic container id, but the panel is not the place to find out
    // what an unescaped one does to the route.
    expect(logPath('a/b?c', query(), false, NOW)).toContain('/containers/a%2Fb%3Fc/logs');
  });
});

describe('normalizeLine', () => {
  it('keeps a well-formed line', () => {
    expect(normalizeLine({ stream: 'stderr', text: 'boom' })).toEqual({
      stream: 'stderr',
      text: 'boom',
    });
  });

  it('treats anything but stderr as ordinary output', () => {
    // Colouring output as an error because a field was misspelled would teach
    // the operator to distrust the colour.
    expect(normalizeLine({ stream: 'weird', text: 'hello' })?.stream).toBe('stdout');
    expect(normalizeLine({ text: 'hello' })?.stream).toBe('stdout');
  });

  it('rejects anything without text', () => {
    expect(normalizeLine({ stream: 'stdout' })).toBeUndefined();
    expect(normalizeLine({ stream: 'stdout', text: 42 })).toBeUndefined();
    expect(normalizeLine('a line')).toBeUndefined();
    expect(normalizeLine(null)).toBeUndefined();
  });
});

describe('normalizeLines', () => {
  it('reads the lines out of a facade response', () => {
    const body = {
      lines: [
        { stream: 'stdout', text: 'listening' },
        { stream: 'stderr', text: 'warning' },
      ],
    };

    expect(normalizeLines(body)).toHaveLength(2);
  });

  it('renders nothing rather than crashing on a shape it did not expect', () => {
    // The panel runs inside someone else's admin UI: a proxy or a partial
    // answer must degrade to an empty view, not to a blank page.
    expect(normalizeLines({})).toEqual([]);
    expect(normalizeLines({ lines: 'nope' })).toEqual([]);
    expect(normalizeLines(null)).toEqual([]);
    expect(normalizeLines('nope')).toEqual([]);
  });

  it('drops the entries that carry no line', () => {
    const body = { lines: [{ text: 'real' }, { stream: 'stdout' }, null, 7] };

    expect(normalizeLines(body)).toEqual([{ stream: 'stdout', text: 'real' }]);
  });
});

describe('parseLineEvent', () => {
  it('reads one SSE data field', () => {
    expect(parseLineEvent('{"stream":"stderr","text":"oh no"}')).toEqual({
      stream: 'stderr',
      text: 'oh no',
    });
  });

  it('drops a frame that is not a line', () => {
    // Rendering the raw frame would look like output the container wrote.
    expect(parseLineEvent('not json')).toBeUndefined();
    expect(parseLineEvent('{"nothing":true}')).toBeUndefined();
  });
});

describe('appendLines', () => {
  const line = (text: string): LogLine => ({ stream: 'stdout', text });
  const texts = (lines: readonly LogLine[]): string[] => lines.map((entry) => entry.text);
  const seqs = (lines: readonly BufferedLine[]): number[] => lines.map((entry) => entry.seq);

  it('appends in order', () => {
    expect(texts(appendLines(appendLines([], [line('one')]), [line('two')]))).toEqual([
      'one',
      'two',
    ]);
  });

  it('keeps the buffer bounded, dropping the oldest', () => {
    // A container writing steadily would otherwise grow the DOM until the tab
    // dies, and the panel runs on whatever the operator is holding.
    const existing = appendLines(
      [],
      Array.from({ length: 5 }, (_, index) => line(`old-${index}`)),
      5,
    );

    const result = appendLines(existing, [line('new')], 5);

    expect(result).toHaveLength(5);
    expect(result[0]?.text).toBe('old-1');
    expect(result[4]?.text).toBe('new');
  });

  it('drops a whole burst larger than the buffer', () => {
    const burst = Array.from({ length: 12 }, (_, index) => line(`burst-${index}`));

    const result = appendLines(appendLines([], [line('old')], 5), burst, 5);

    expect(result).toHaveLength(5);
    expect(result[0]?.text).toBe('burst-7');
  });

  it('returns what it was given when there is nothing to add', () => {
    const existing = appendLines([], [line('one')]);

    expect(appendLines(existing, [])).toBe(existing);
  });

  it('defaults to a ceiling a browser can hold', () => {
    const burst = Array.from({ length: MAX_LINES + 10 }, (_, index) => line(`x-${index}`));

    expect(appendLines([], burst)).toHaveLength(MAX_LINES);
  });

  it('gives every line an identity that never moves under it', () => {
    // The viewer keys its rows on this. An index key changes for every line
    // still on screen the moment the buffer starts dropping its oldest, and
    // React answers that by unmounting and rebuilding all 5000 rows — per
    // arriving line.
    let buffer = appendLines(
      [],
      Array.from({ length: 3 }, (_, index) => line(`old-${index}`)),
      3,
    );
    const before = seqs(buffer);

    buffer = appendLines(buffer, [line('new')], 3);

    // The two lines that survived kept the numbers they already had, even
    // though both moved one place towards the front.
    expect(seqs(buffer).slice(0, 2)).toEqual(before.slice(1));
    expect(seqs(buffer)[2]).toBe((before[2] ?? 0) + 1);
    expect(new Set(seqs(buffer)).size).toBe(3);
  });

  it('keeps numbering upwards across many drops, never reusing one', () => {
    let buffer = appendLines([], [line('first')], 2);
    const seen = new Set<number>(seqs(buffer));

    for (let index = 0; index < 20; index += 1) {
      buffer = appendLines(buffer, [line(`line-${index}`)], 2);
      for (const seq of seqs(buffer)) seen.add(seq);
    }

    expect(seen.size).toBe(21);
    expect(seqs(buffer)).toEqual([19, 20]);
  });
});

describe('toText', () => {
  it('marks the stderr lines, since a text file has no colour', () => {
    const text = toText([
      { stream: 'stdout', text: 'listening' },
      { stream: 'stderr', text: 'boom' },
    ]);

    expect(text).toBe('listening\n[stderr] boom\n');
  });

  it('says nothing when there is nothing', () => {
    expect(toText([])).toBe('');
  });
});

describe('downloadName', () => {
  it('names the container, the instance and the moment', () => {
    const name = downloadName('signalk_influxdb', 'boat', new Date(NOW));

    expect(name).toBe('boat-signalk_influxdb-2026-08-22T12-00-00Z.log');
  });

  it('says the stamp is UTC, since nothing else in the filename does', () => {
    // Without the Z this reads as a local wall-clock time and is not one. Log
    // filenames are exactly what gets lined up against the moment an incident
    // was noticed, and a boat is rarely on UTC — an hours-out filename sends
    // whoever is reading it to the wrong part of the log.
    const stamped = downloadName('web', 'boat', new Date(Date.UTC(2026, 7, 22, 23, 30, 0)));

    expect(stamped).toContain('2026-08-22T23-30-00Z');
    expect(stamped.endsWith('Z.log')).toBe(true);
  });

  it('keeps a name with awkward characters usable as a filename', () => {
    expect(downloadName('my stack/web', undefined, new Date(NOW))).toBe(
      'my_stack_web-2026-08-22T12-00-00Z.log',
    );
  });
});

describe('canFollow', () => {
  it('reports what the browser can do', () => {
    const original = (globalThis as { EventSource?: unknown }).EventSource;
    try {
      delete (globalThis as { EventSource?: unknown }).EventSource;
      expect(canFollow()).toBe(false);

      (globalThis as { EventSource?: unknown }).EventSource = class {};
      expect(canFollow()).toBe(true);
    } finally {
      if (original === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
      else (globalThis as { EventSource?: unknown }).EventSource = original;
    }
  });
});
