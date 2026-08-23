/**
 * The socket to the plugin's console endpoint.
 *
 * Kept behind a factory for the same reason the server keeps its own connector
 * behind one: the dialog's logic is worth testing, and a real WebSocket in a
 * test is a network connection that will not be made.
 */

export interface ConsoleSocketHandlers {
  onOpen(): void;
  /** Bytes from the shell, already decoded. */
  onText(text: string): void;
  onClose(code: number, reason: string): void;
}

export interface ConsoleSocket {
  send(text: string): void;
  close(): void;
}

export type SocketFactory = (url: string, handlers: ConsoleSocketHandlers) => ConsoleSocket;

/**
 * One frame as text.
 *
 * The decoder is the caller's and is reused across frames on purpose: a shell
 * writing anything but ASCII can split a UTF-8 sequence across two frames, and
 * decoding each frame on its own turns the split character into two replacement
 * marks that never resolve.
 */
export function decodeFrame(data: unknown, decoder: TextDecoder): string {
  if (typeof data === 'string') return data;
  if (ArrayBuffer.isView(data)) {
    return decoder.decode(data as unknown as ArrayBufferView, { stream: true });
  }
  // `instanceof` rather than only that: a buffer built in another realm — an
  // iframe, or the test environment — is an ArrayBuffer that fails the
  // instance check, and dropping the frame would look like the shell going
  // quiet.
  if (
    data instanceof ArrayBuffer ||
    Object.prototype.toString.call(data) === '[object ArrayBuffer]'
  ) {
    return decoder.decode(data as ArrayBuffer, { stream: true });
  }
  // Only reachable if binaryType were left at its default of 'blob', which the
  // factory below sets away from; there is nothing synchronous to do with one.
  return '';
}

/** The real socket. Same origin as the page, so the session cookie is not needed. */
export function browserSocket(url: string, handlers: ConsoleSocketHandlers): ConsoleSocket {
  const socket = new WebSocket(url);
  // Frames arrive as bytes rather than as Blobs, so they can be decoded without
  // a further await between the shell and the screen.
  socket.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();

  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (event: MessageEvent<unknown>) => {
    const text = decodeFrame(event.data, decoder);
    if (text.length > 0) handlers.onText(text);
  };
  socket.onclose = (event: CloseEvent) => handlers.onClose(event.code, event.reason);
  // No handler for 'error': the browser follows every error with a close, and
  // the close carries a code, which is the only part worth telling anyone.

  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close: () => socket.close(),
  };
}
