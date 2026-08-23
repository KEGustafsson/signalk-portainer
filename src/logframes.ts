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

// Imported rather than taken from the global scope: the plugin build compiles
// without the DOM lib, and @types/node declares TextDecoder only as a value,
// so the global name has no type to refer to here.
import { TextDecoder } from 'node:util';

export type LogStreamName = 'stdout' | 'stderr';

export interface LogFrame {
  stream: LogStreamName;
  text: string;
}

const HEADER_BYTES = 8;
/** Docker's stream numbers: 0 stdin (never seen in logs), 1 stdout, 2 stderr. */
const STDERR = 2;

/**
 * The largest payload a single frame may claim.
 *
 * Only the first eight bytes of a stream are ever checked for framing; after
 * that every 4-byte length is taken on trust. A stream that has gone out of
 * sync — a proxy that injected bytes, a container writing its own framing —
 * then yields a length of hundreds of megabytes, and the demuxer buffers every
 * chunk that arrives waiting for a frame that never completes. 8 MiB is far
 * above anything Docker produces: its log copier writes at most its read buffer
 * per frame, which is tens of kilobytes.
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

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
 * Whether a fragment shorter than a header could be the start of one.
 *
 * Only asked when a stream ended before eight bytes arrived. Same shape as
 * {@link looksMultiplexed}, tested against however much there is: a stream
 * number of 0-2 followed by zeroes. Log text does not begin that way, so a
 * container whose whole output is "hi\n" is not mistaken for framing and
 * thrown away.
 */
function looksLikeHeaderStart(chunk: Uint8Array): boolean {
  const type = chunk[0];
  if (type === undefined || type > STDERR) return false;
  return chunk.subarray(1, 4).every((byte) => byte === 0);
}

/**
 * Reassembles Docker's log framing across arbitrary chunk boundaries.
 *
 * One demuxer per stream: it holds the bytes of an incomplete frame between
 * calls, so a caller can feed it whatever the socket happened to deliver.
 */
export class LogDemuxer {
  /**
   * The chunks not yet consumed, oldest first, holding {@link pending} bytes
   * between them.
   *
   * A list rather than one growing buffer: concatenating on every push copies
   * the whole remainder each time, so a 4 MiB frame arriving in 16 KiB reads
   * copies about 537 MB on its way through. Bytes are joined only when a
   * complete frame is there to hand over.
   */
  private chunks: Uint8Array[] = [];
  private pending = 0;
  private multiplexed: boolean | undefined;
  /**
   * One streaming decoder per stream.
   *
   * Docker's log copier splits a message longer than its read buffer into
   * several frames without regard for UTF-8 boundaries, so a character can
   * straddle two frames of the same stream. A fresh decoder per frame turns
   * each half into its own replacement character; a streaming one holds the
   * leading bytes until the rest arrives. Per stream rather than shared,
   * because stdout and stderr frames interleave.
   */
  private readonly decoders: Record<LogStreamName, TextDecoder> = {
    stdout: new TextDecoder('utf8'),
    stderr: new TextDecoder('utf8'),
  };

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
    this.chunks.push(chunk);
    this.pending += chunk.length;

    if (this.multiplexed === undefined) {
      // Not enough bytes to tell yet — wait rather than guess, since guessing
      // wrong turns the first 8 bytes of output into a phantom frame.
      if (this.pending < HEADER_BYTES) return [];
      this.multiplexed = looksMultiplexed(this.peek(HEADER_BYTES));
    }

    if (!this.multiplexed) {
      // A TTY stream: the bytes are the output, and everything is stdout —
      // Docker merges stderr into it when a TTY is attached.
      const text = this.decoders.stdout.decode(this.take(this.pending), { stream: true });
      return text ? [{ stream: 'stdout', text }] : [];
    }

    const frames: LogFrame[] = [];
    for (;;) {
      if (this.pending < HEADER_BYTES) break;
      const length = this.frameLength();
      if (length > MAX_FRAME_BYTES) {
        // Nothing after this point can be trusted to be framing, and holding
        // the bytes would grow without bound, so the stream ends here rather
        // than quietly consuming memory.
        this.chunks = [];
        this.pending = 0;
        throw new Error(
          `Docker log frame claims ${length} bytes, past the ${MAX_FRAME_BYTES}-byte limit — the stream is out of sync`,
        );
      }
      if (this.pending < HEADER_BYTES + length) break;

      const header = this.take(HEADER_BYTES);
      const stream: LogStreamName = header[0] === STDERR ? 'stderr' : 'stdout';
      const text = this.decoders[stream].decode(this.take(length), { stream: true });
      // A frame whose bytes were all the tail of a character contributes no
      // text; emitting it would put an empty line on screen.
      if (text) frames.push({ stream, text });
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
    const remainder = this.take(this.pending);
    const frames: LogFrame[] = [];

    // Mode detection withholds the first bytes until eight have arrived, so a
    // TTY container whose entire log is shorter than a header — "hi\n" —
    // reaches here still undecided. Treating undecided as multiplexed dropped
    // that log entirely, since the branch below discards a remainder that short
    // as framing; treating it as raw would print a truncated header as text.
    // So it is decided from the shape of what did arrive.
    this.multiplexed ??= looksLikeHeaderStart(remainder);

    if (!this.multiplexed) {
      const text = this.decoders.stdout.decode(remainder);
      if (text) frames.push({ stream: 'stdout', text });
      return frames;
    }

    // A partial multiplexed frame. Anything up to the header length is framing
    // rather than output, and emitting it would put raw bytes on screen; only
    // what follows a complete header is text the container actually wrote.
    if (remainder.length > HEADER_BYTES) {
      const stream: LogStreamName = remainder[0] === STDERR ? 'stderr' : 'stdout';
      const text = this.decoders[stream].decode(remainder.subarray(HEADER_BYTES));
      if (text) frames.push({ stream, text });
    }

    // Both decoders are flushed: a stream that ended mid-character still holds
    // those bytes, and ending without flushing loses them silently.
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = this.decoders[stream].decode();
      if (text) frames.push({ stream, text });
    }
    return frames;
  }

  /** The payload length in the header at the front of the pending bytes. */
  private frameLength(): number {
    return (
      this.byteAt(4) * 0x1000000 + (this.byteAt(5) << 16) + (this.byteAt(6) << 8) + this.byteAt(7)
    );
  }

  /** One pending byte by index, without joining the chunks holding it. */
  private byteAt(index: number): number {
    let at = index;
    for (const chunk of this.chunks) {
      if (at < chunk.length) return chunk[at] ?? 0;
      at -= chunk.length;
    }
    return 0;
  }

  /** The first `count` bytes, copied out without consuming them. */
  private peek(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) out[index] = this.byteAt(index);
    return out;
  }

  /** Removes the first `count` pending bytes and returns them as one array. */
  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let written = 0;
    while (written < count) {
      const chunk = this.chunks[0];
      if (!chunk) break;
      const wanted = Math.min(chunk.length, count - written);
      out.set(chunk.subarray(0, wanted), written);
      if (wanted === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(wanted);
      written += wanted;
    }
    this.pending -= written;
    return out;
  }
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
