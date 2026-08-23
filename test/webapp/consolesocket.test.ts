/**
 * @jest-environment jsdom
 */
import {
  browserSocket,
  decodeFrame,
  type ConsoleSocketHandlers,
} from '../../src/webapp/consolesocket';

describe('decodeFrame', () => {
  it('passes text through', () => {
    expect(decodeFrame('total 0\r\n', new TextDecoder())).toBe('total 0\r\n');
  });

  it('decodes bytes', () => {
    const bytes = new TextEncoder().encode('total 0\r\n');
    expect(decodeFrame(bytes.buffer, new TextDecoder())).toBe('total 0\r\n');
  });

  it('decodes a view over bytes', () => {
    expect(decodeFrame(new TextEncoder().encode('hello'), new TextDecoder())).toBe('hello');
  });

  it('joins a character that arrived in two frames', () => {
    // A shell printing anything but ASCII can split a UTF-8 sequence across
    // frames; decoding each on its own leaves two replacement marks forever.
    const decoder = new TextDecoder();
    const bytes = new TextEncoder().encode('°C');

    const first = decodeFrame(bytes.slice(0, 1).buffer, decoder);
    const second = decodeFrame(bytes.slice(1).buffer, decoder);

    expect(first + second).toBe('°C');
  });

  it('has nothing to say about a shape it cannot decode', () => {
    expect(decodeFrame(undefined, new TextDecoder())).toBe('');
    expect(decodeFrame({ data: 'x' }, new TextDecoder())).toBe('');
  });
});

/** The browser's WebSocket, driven by the test. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = 1;

  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

describe('browserSocket', () => {
  const handlers = (): ConsoleSocketHandlers & {
    opened: number;
    text: string[];
    ends: unknown[];
  } => {
    const record = {
      opened: 0,
      text: [] as string[],
      ends: [] as unknown[],
      onOpen: () => (record.opened += 1),
      onText: (value: string) => record.text.push(value),
      onClose: (code: number, reason: string) => record.ends.push({ code, reason }),
    };
    return record;
  };

  const original = globalThis.WebSocket;
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = original;
  });

  const socketFor = (record: ConsoleSocketHandlers) => {
    const console = browserSocket('ws://boat/console?ticket=t', record);
    const raw = FakeWebSocket.instances[0]!;
    return { console, raw };
  };

  it('asks for bytes rather than blobs', () => {
    // A Blob would need a further await between the shell and the screen, and
    // there is nothing synchronous to do with one.
    const { raw } = socketFor(handlers());

    expect(raw.binaryType).toBe('arraybuffer');
  });

  it('reports the socket opening', () => {
    const record = handlers();
    const { raw } = socketFor(record);

    raw.onopen?.();

    expect(record.opened).toBe(1);
  });

  it('decodes what the shell printed', () => {
    const record = handlers();
    const { raw } = socketFor(record);

    raw.onmessage?.({ data: new TextEncoder().encode('total 0\r\n').buffer });

    expect(record.text).toEqual(['total 0\r\n']);
  });

  it('says nothing for a frame that decoded to nothing', () => {
    const record = handlers();
    const { raw } = socketFor(record);

    raw.onmessage?.({ data: new ArrayBuffer(0) });

    expect(record.text).toEqual([]);
  });

  it('reports the close with its code', () => {
    const record = handlers();
    const { raw } = socketFor(record);

    raw.onclose?.({ code: 4408, reason: 'idle' });

    expect(record.ends).toEqual([{ code: 4408, reason: 'idle' }]);
  });

  it('sends what was typed once the socket is open', () => {
    const { console, raw } = socketFor(handlers());
    raw.readyState = 1;

    console.send('ls\n');

    expect(raw.sent).toEqual(['ls\n']);
  });

  it('drops what was typed before the socket was open', () => {
    // Sending on a connecting socket throws, and taking the page down over a
    // keystroke that arrived a moment early is not worth it.
    const { console, raw } = socketFor(handlers());

    expect(() => console.send('ls\n')).not.toThrow();
    expect(raw.sent).toEqual([]);
  });

  it('closes the underlying socket', () => {
    const { console, raw } = socketFor(handlers());

    console.close();

    expect(raw.closed).toBe(true);
  });
});
