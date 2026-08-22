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

  it('appends in order', () => {
    expect(appendLines([line('one')], [line('two')])).toEqual([line('one'), line('two')]);
  });

  it('keeps the buffer bounded, dropping the oldest', () => {
    // A container writing steadily would otherwise grow the DOM until the tab
    // dies, and the panel runs on whatever the operator is holding.
    const existing = Array.from({ length: 5 }, (_, index) => line(`old-${index}`));

    const result = appendLines(existing, [line('new')], 5);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(line('old-1'));
    expect(result[4]).toEqual(line('new'));
  });

  it('drops a whole burst larger than the buffer', () => {
    const burst = Array.from({ length: 12 }, (_, index) => line(`burst-${index}`));

    const result = appendLines([line('old')], burst, 5);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(line('burst-7'));
  });

  it('returns what it was given when there is nothing to add', () => {
    const existing = [line('one')];

    expect(appendLines(existing, [])).toBe(existing);
  });

  it('defaults to a ceiling a browser can hold', () => {
    const burst = Array.from({ length: MAX_LINES + 10 }, (_, index) => line(`x-${index}`));

    expect(appendLines([], burst)).toHaveLength(MAX_LINES);
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

    expect(name).toBe('boat-signalk_influxdb-2026-08-22T12-00-00.log');
  });

  it('keeps a name with awkward characters usable as a filename', () => {
    expect(downloadName('my stack/web', undefined, new Date(NOW))).toBe(
      'my_stack_web-2026-08-22T12-00-00.log',
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
