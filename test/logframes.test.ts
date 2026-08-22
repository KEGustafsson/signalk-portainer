import { LogDemuxer, looksMultiplexed, toLines } from '../src/logframes';

/** Builds one Docker log frame: 8-byte header then payload. */
const frame = (stream: 1 | 2, text: string): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  const bytes = new Uint8Array(8 + payload.length);
  bytes[0] = stream;
  new DataView(bytes.buffer).setUint32(4, payload.length, false);
  bytes.set(payload, 8);
  return bytes;
};

const raw = (text: string): Uint8Array => new TextEncoder().encode(text);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};

describe('looksMultiplexed', () => {
  it('recognises a Docker frame header', () => {
    expect(looksMultiplexed(frame(1, 'hello'))).toBe(true);
    expect(looksMultiplexed(frame(2, 'oh no'))).toBe(true);
  });

  it('does not mistake plain text for framing', () => {
    expect(looksMultiplexed(raw('2026-08-22 starting up'))).toBe(false);
    expect(looksMultiplexed(raw('hello world'))).toBe(false);
  });

  it('cannot decide from fewer bytes than a header', () => {
    expect(looksMultiplexed(raw('abc'))).toBe(false);
  });
});

describe('LogDemuxer', () => {
  it('separates stdout from stderr', () => {
    const demuxer = new LogDemuxer();

    const frames = demuxer.push(concat(frame(1, 'listening\n'), frame(2, 'warning\n')));

    expect(frames).toEqual([
      { stream: 'stdout', text: 'listening\n' },
      { stream: 'stderr', text: 'warning\n' },
    ]);
  });

  it('reassembles a frame split across chunks', () => {
    // The socket delivers what it delivers; frames do not align with reads.
    const whole = frame(1, 'a long line of output');
    const demuxer = new LogDemuxer();

    expect(demuxer.push(whole.subarray(0, 5))).toEqual([]);
    expect(demuxer.push(whole.subarray(5, 12))).toEqual([]);
    const frames = demuxer.push(whole.subarray(12));

    expect(frames).toEqual([{ stream: 'stdout', text: 'a long line of output' }]);
  });

  it('emits only the frames a chunk completed, holding the rest', () => {
    const demuxer = new LogDemuxer();
    const partial = frame(1, 'second');

    const frames = demuxer.push(concat(frame(1, 'first'), partial.subarray(0, 10)));

    expect(frames).toEqual([{ stream: 'stdout', text: 'first' }]);
    expect(demuxer.push(partial.subarray(10))).toEqual([{ stream: 'stdout', text: 'second' }]);
  });

  it('handles a header split across chunks', () => {
    const whole = frame(2, 'boom');
    const demuxer = new LogDemuxer();

    expect(demuxer.push(whole.subarray(0, 3))).toEqual([]);
    expect(demuxer.push(whole.subarray(3))).toEqual([{ stream: 'stderr', text: 'boom' }]);
  });

  it('passes a TTY stream through unframed', () => {
    const demuxer = new LogDemuxer();

    const frames = demuxer.push(raw('plain tty output\n'));

    // A TTY merges stderr into stdout, so everything is stdout.
    expect(frames).toEqual([{ stream: 'stdout', text: 'plain tty output\n' }]);
  });

  it('waits for enough bytes before deciding which kind of stream it is', () => {
    const demuxer = new LogDemuxer();

    // Guessing from three bytes would turn the start of the output into a
    // phantom frame header.
    expect(demuxer.push(raw('abc'))).toEqual([]);
    expect(demuxer.push(raw('defghij'))).toEqual([{ stream: 'stdout', text: 'abcdefghij' }]);
  });

  it('takes the caller at their word when the TTY setting is known', () => {
    // Output that happens to start with bytes resembling a header.
    const demuxer = new LogDemuxer(false);

    const frames = demuxer.push(concat(new Uint8Array([1, 0, 0, 0]), raw('abcd')));

    expect(frames[0]?.stream).toBe('stdout');
    expect(frames).toHaveLength(1);
  });

  it('keeps a multi-byte character intact across a split', () => {
    const whole = frame(1, 'räksmörgås');
    const demuxer = new LogDemuxer();

    demuxer.push(whole.subarray(0, 12));
    const frames = demuxer.push(whole.subarray(12));

    expect(frames).toEqual([{ stream: 'stdout', text: 'räksmörgås' }]);
  });

  describe('flush', () => {
    it('emits a truncated frame rather than losing the last line', () => {
      // A container killed mid-write still wrote something.
      const demuxer = new LogDemuxer();
      const partial = frame(2, 'dying words');
      demuxer.push(partial.subarray(0, 14));

      // Six payload bytes arrived of the eleven the header promised.
      expect(demuxer.flush()).toEqual([{ stream: 'stderr', text: 'dying ' }]);
    });

    it('emits the tail of a TTY stream', () => {
      const demuxer = new LogDemuxer(false);
      demuxer.push(raw('no trailing newline'));

      // Already emitted on push; nothing is held back for a raw stream.
      expect(demuxer.flush()).toEqual([]);
    });

    it('says nothing when there is nothing left', () => {
      const demuxer = new LogDemuxer();
      demuxer.push(frame(1, 'complete'));

      expect(demuxer.flush()).toEqual([]);
    });
  });
});

describe('toLines', () => {
  it("splits frames into lines, keeping each line's stream", () => {
    const lines = toLines([
      { stream: 'stdout', text: 'one\ntwo\n' },
      { stream: 'stderr', text: 'bad\n' },
    ]);

    expect(lines).toEqual([
      { stream: 'stdout', text: 'one' },
      { stream: 'stdout', text: 'two' },
      { stream: 'stderr', text: 'bad' },
    ]);
  });

  it('drops the carriage return of CRLF output', () => {
    expect(toLines([{ stream: 'stdout', text: 'windows\r\n' }])).toEqual([
      { stream: 'stdout', text: 'windows' },
    ]);
  });

  it('drops empty lines rather than rendering blank rows', () => {
    expect(toLines([{ stream: 'stdout', text: '\n\nreal\n\n' }])).toEqual([
      { stream: 'stdout', text: 'real' },
    ]);
  });
});
