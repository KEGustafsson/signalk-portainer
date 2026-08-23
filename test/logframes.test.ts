import { LogDemuxer, looksMultiplexed, toLines, type LogFrame } from '../src/logframes';

/** One Docker log frame around arbitrary payload bytes: 8-byte header, then them. */
const byteFrame = (stream: 1 | 2, payload: ArrayLike<number>): Uint8Array => {
  const bytes = new Uint8Array(8 + payload.length);
  bytes[0] = stream;
  new DataView(bytes.buffer).setUint32(4, payload.length, false);
  bytes.set(payload, 8);
  return bytes;
};

/** Builds one Docker log frame around text. */
const frame = (stream: 1 | 2, text: string): Uint8Array =>
  byteFrame(stream, new TextEncoder().encode(text));

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

  it('keeps a character that Docker split across two frames', () => {
    // Docker's log copier cuts a message at its read buffer without regard for
    // UTF-8 boundaries, so the two bytes of 'ä' arrive in separate frames of
    // the same stream. Decoding each frame on its own yields two replacement
    // characters and the operator sees mojibake in an otherwise fine log.
    const demuxer = new LogDemuxer();

    const first = demuxer.push(byteFrame(1, [0xc3]));
    const second = demuxer.push(byteFrame(1, [0xa4]));

    expect(first).toEqual([]);
    expect(second).toEqual([{ stream: 'stdout', text: 'ä' }]);
  });

  it('keeps stdout and stderr from decoding each other’s half characters', () => {
    // Interleaved streams: the stderr frame between the two halves of the
    // stdout character must not consume them.
    const demuxer = new LogDemuxer();

    const frames = [
      ...demuxer.push(byteFrame(1, [0xc3])),
      ...demuxer.push(frame(2, 'warning\n')),
      ...demuxer.push(byteFrame(1, [0xa4])),
    ];

    expect(frames).toEqual([
      { stream: 'stderr', text: 'warning\n' },
      { stream: 'stdout', text: 'ä' },
    ]);
  });

  it('ends the stream rather than buffering a frame length it cannot believe', () => {
    // Only the first eight bytes are ever checked for framing; after that a
    // corrupt length is taken on trust, and the demuxer holds every chunk that
    // follows waiting for a frame that never completes.
    const demuxer = new LogDemuxer();
    const corrupt = new Uint8Array([2, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);

    expect(() => demuxer.push(corrupt)).toThrow(/out of sync/);
    // And the bytes went with it: nothing is held back for a stream that has
    // already been declared unreadable.
    expect(demuxer.flush()).toEqual([]);
  });

  it('reassembles a large frame delivered in many small reads', () => {
    // 1 MiB in 16 KiB pieces, which is what a container writing a stack trace
    // looks like on the wire. Concatenating the whole pending buffer per push
    // makes this quadratic; the frames themselves must still come out whole.
    const line = 'x'.repeat(1024 * 1024);
    const whole = frame(1, line);
    const demuxer = new LogDemuxer();

    const frames: LogFrame[] = [];
    for (let at = 0; at < whole.length; at += 16 * 1024) {
      frames.push(...demuxer.push(whole.subarray(at, at + 16 * 1024)));
    }

    expect(frames).toEqual([{ stream: 'stdout', text: line }]);
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

    it('holds back a fragment too short to carry any output', () => {
      // Six bytes of an eight-byte header and nothing else. There is no text
      // in them, and decoding them anyway would print control bytes as a log
      // line.
      const demuxer = new LogDemuxer();
      demuxer.push(frame(2, 'dying words').subarray(0, 6));

      expect(demuxer.flush()).toEqual([]);
    });

    it('says nothing for a complete header with no payload behind it', () => {
      const demuxer = new LogDemuxer();
      demuxer.push(frame(1, 'never written').subarray(0, 8));

      expect(demuxer.flush()).toEqual([]);
    });

    it('emits the tail of a TTY stream', () => {
      const demuxer = new LogDemuxer(false);
      demuxer.push(raw('no trailing newline'));

      // Already emitted on push; nothing is held back for a raw stream.
      expect(demuxer.flush()).toEqual([]);
    });

    it('emits a TTY log shorter than a frame header', () => {
      // Mode detection holds the first bytes back until eight arrive, so a
      // container whose whole log is three bytes is still undecided at the
      // end. Deciding "multiplexed" there discarded the log as framing and the
      // panel showed an empty pane for a container that had printed something.
      const demuxer = new LogDemuxer();

      expect(demuxer.push(raw('hi\n'))).toEqual([]);
      expect(demuxer.flush()).toEqual([{ stream: 'stdout', text: 'hi\n' }]);
    });

    it('does not lose the bytes a decoder is still holding', () => {
      // The stream ended in the middle of a character. The bytes are not text
      // and never will be, but dropping them silently loses the fact that
      // something was there.
      const demuxer = new LogDemuxer();
      demuxer.push(byteFrame(1, [0xc3]));

      expect(demuxer.flush()).toEqual([{ stream: 'stdout', text: '�' }]);
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
