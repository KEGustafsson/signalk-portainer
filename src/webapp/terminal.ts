/**
 * The terminal, as much of it as the dialog needs to know about.
 *
 * Narrow on purpose. xterm.js is 121 KB gzipped next to the panel's own 45 KB,
 * so it is not in the bundle the admin UI loads to show a table of containers —
 * it arrives in its own chunk, the first time somebody opens a shell. Keeping
 * the dialog behind this interface is what makes that possible, and it is also
 * what lets the dialog be tested without a canvas.
 */

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface Terminal {
  /** Bytes from the shell, on their way to the screen. */
  write(data: string): void;
  /** Keystrokes on their way to the shell. */
  onData(listener: (data: string) => void): void;
  /** The size changed, and Docker has to be told. */
  onResize(listener: (size: TerminalSize) => void): void;
  /** Re-measures against the element it was given. */
  fit(): void;
  focus(): void;
  dispose(): void;
  readonly size: TerminalSize;
}

export type TerminalFactory = (host: HTMLElement) => Promise<Terminal>;

/**
 * The real terminal, fetched only when one is wanted.
 *
 * The import is inside the function rather than at the top of the file so that
 * webpack emits it as a separate chunk: a panel that never opens a shell never
 * downloads a terminal emulator.
 */
export const lazyTerminal: TerminalFactory = async (host) => {
  const { createXtermTerminal } = await import('./xtermterminal');
  return createXtermTerminal(host);
};
