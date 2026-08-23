/**
 * xterm.js behind the `Terminal` interface.
 *
 * Nothing imports this at the top of a file: it is reached only through
 * `lazyTerminal`, so webpack keeps it and everything it pulls in — the emulator
 * and its stylesheet — out of the chunk the admin UI loads.
 */

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as Xterm } from '@xterm/xterm';
// Inlined by webpack as a string (`asset/source`) rather than fetched: the
// panel is served from a boat's own Signal K server, and a stylesheet that
// arrives separately is one more request that can fail on a bad link.
import xtermStyles from '@xterm/xterm/css/xterm.css';
import type { Terminal, TerminalSize } from './terminal';

const STYLE_ID = 'signalk-portainer-xterm-styles';

/** Adds xterm's stylesheet to the page, once however many terminals are opened. */
function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = xtermStyles;
  document.head.appendChild(style);
}

export function createXtermTerminal(host: HTMLElement): Terminal {
  ensureStyles();
  const terminal = new Xterm({
    // A terminal is where an operator reads an error message they will retype
    // somewhere else, so it follows the panel's dark surface rather than the
    // page's theme.
    theme: { background: '#101418', foreground: '#e6e6e6', cursor: '#e6e6e6' },
    fontSize: 13,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    // The shell's own scrollback is not available to us, so this is all there
    // is; enough to page back through a build log without holding a boat's
    // browser to ransom.
    scrollback: 5000,
    cursorBlink: true,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);

  return {
    write: (data) => terminal.write(data),
    onData: (listener) => {
      terminal.onData(listener);
    },
    onResize: (listener) => {
      terminal.onResize(({ cols, rows }) => listener({ cols, rows }));
    },
    fit: () => {
      // Throws while the element is still being laid out, or hidden; the size
      // it would have computed is not worth an exception in the dialog.
      try {
        fit.fit();
      } catch {
        /* the next resize will do it */
      }
    },
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
    get size(): TerminalSize {
      return { cols: terminal.cols, rows: terminal.rows };
    },
  };
}
