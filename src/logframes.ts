/**
 * Docker's log stream framing.
 *
 * A container started without a TTY has its stdout and stderr multiplexed into
 * one stream, each write prefixed by an 8-byte header: one byte of stream
 * number, three zero bytes, then a big-endian uint32 payload length. A TTY
 * container has no framing at all — the bytes are the output.
 *
 * Frames do not align with network chunks: a header can arrive split across
 * two reads, and a payload can span many. This is the state machine that puts
 * them back together, so nothing above it ever sees a partial frame or the
 * framing bytes themselves.
 */

export type LogStreamName = 'stdout' | 'stderr';

export interface LogFrame {
  stream: LogStreamName;
  text: string;
}

const HEADER_BYTES = 8;
/** Docker's stream numbers: 0 stdin (never seen in logs), 1 stdout, 2 stderr. */
const STDERR = 2;

/**
 * `Uint8Array<ArrayBuffer>` rather than the default `ArrayBufferLike`: a chunk
 * backed by a SharedArrayBuffer cannot be handed to DataView the way this code
 * does, and the distinction is worth keeping in the type rather than casting it
 * away at every use.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Whether a stream looks multiplexed, from its first bytes.
 *
 * Docker tells you authoritatively in the container's `Config.Tty`, but that
 * costs an inspect per log request. The header shape is distinctive enough to
 * read directly: a stream number of 0-2 followed by three zero bytes is not a
 * sequence that plain text produces, since those are control characters that do
 * not appear in log output.
 */
export function looksMultiplexed(chunk: Uint8Array): boolean {
  if (chunk.length < HEADER_BYTES) return false;
  const [type, a, b, c] = chunk;
  if (type === undefined || a === undefined || b === undefined || c === undefined) return false;
  return type <= STDERR && a === 0 && b === 0 && c === 0;
}

/**
 * Reassembles Docker's log framing across arbitrary chunk boundaries.
 *
 * One demuxer per stream: it holds the bytes of an incomplete frame between
 * calls, so a caller can feed it whatever the socket happened to deliver.
 */
export class LogDemuxer {
  private buffer: Bytes = new Uint8Array(0);
  private multiplexed: boolean | undefined;
  private readonly decoder = new TextDecoder('utf8');

  /**
   * @param assumeMultiplexed skips the heuristic when the caller already knows,
   * from the container's `Config.Tty`, which kind of stream this is.
   */
  constructor(assumeMultiplexed?: boolean) {
    this.multiplexed = assumeMultiplexed;
  }

  /** The frames completed by this chunk. Partial frames are held for the next. */
  push(chunk: Uint8Array): LogFrame[] {
    if (chunk.length === 0) return [];
    this.buffer = concat(this.buffer, chunk);

    if (this.multiplexed === undefined) {
      // Not enough bytes to tell yet — wait rather than guess, since guessing
      // wrong turns the first 8 bytes of output into a phantom frame.
      if (this.buffer.length < HEADER_BYTES) return [];
      this.multiplexed = looksMultiplexed(this.buffer);
    }

    if (!this.multiplexed) {
      // A TTY stream: the bytes are the output, and everything is stdout —
      // Docker merges stderr into it when a TTY is attached.
      const text = this.decoder.decode(this.buffer, { stream: true });
      this.buffer = new Uint8Array(0);
      return text ? [{ stream: 'stdout', text }] : [];
    }

    const frames: LogFrame[] = [];
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const length = view.getUint32(4, false);
      if (this.buffer.length < HEADER_BYTES + length) break;

      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      frames.push({
        stream: this.buffer[0] === STDERR ? 'stderr' : 'stdout',
        // Not streaming-decoded: each frame is a complete write, and a
        // multi-byte character never straddles two of them.
        text: new TextDecoder('utf8').decode(payload),
      });
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }
    return frames;
  }

  /**
   * Whatever is left when the stream ends.
   *
   * A truncated frame still carries output the operator wants — a container
   * killed mid-write should not lose its last line — so the remainder is
   * emitted rather than discarded.
   */
  flush(): LogFrame[] {
    if (this.buffer.length === 0) return [];
    const remainder = this.buffer;
    this.buffer = new Uint8Array(0);

    if (this.multiplexed === false) {
      const text = this.decoder.decode(remainder);
      return text ? [{ stream: 'stdout', text }] : [];
    }
    // A partial multiplexed frame: drop the header if it is complete, since
    // those bytes are framing rather than output.
    const body = remainder.length > HEADER_BYTES ? remainder.subarray(HEADER_BYTES) : remainder;
    const stream: LogStreamName =
      remainder.length > HEADER_BYTES && remainder[0] === STDERR ? 'stderr' : 'stdout';
    const text = new TextDecoder('utf8').decode(body);
    return text ? [{ stream, text }] : [];
  }
}

function concat(left: Bytes, right: Uint8Array): Bytes {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

/** Splits frames into whole lines, keeping each line's stream. */
export function toLines(frames: readonly LogFrame[]): LogFrame[] {
  const lines: LogFrame[] = [];
  for (const frame of frames) {
    for (const piece of frame.text.split('\n')) {
      if (piece.length > 0) lines.push({ stream: frame.stream, text: piece.replace(/\r$/, '') });
    }
  }
  return lines;
}
