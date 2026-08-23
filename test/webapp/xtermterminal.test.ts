/**
 * @jest-environment jsdom
 */

/** The xterm instances the adapter built, and what it asked of them. */
const built: FakeXterm[] = [];
let fitFails = false;

class FakeXterm {
  cols = 80;
  rows = 24;
  opened: HTMLElement | undefined;
  addons: unknown[] = [];
  written: string[] = [];
  disposed = false;
  focused = 0;
  dataListener: ((data: string) => void) | undefined;
  resizeListener: ((size: { cols: number; rows: number }) => void) | undefined;

  constructor(readonly options: Record<string, unknown>) {
    built.push(this);
  }
  loadAddon(addon: unknown): void {
    this.addons.push(addon);
  }
  open(host: HTMLElement): void {
    this.opened = host;
  }
  write(data: string): void {
    this.written.push(data);
  }
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onResize(listener: (size: { cols: number; rows: number }) => void): void {
    this.resizeListener = listener;
  }
  focus(): void {
    this.focused += 1;
  }
  dispose(): void {
    this.disposed = true;
  }
}

jest.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      return new FakeXterm(options);
    }
  },
}));

jest.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      if (fitFails) throw new Error('element has no size yet');
    }
  },
}));

import { createXtermTerminal } from '../../src/webapp/xtermterminal';

describe('createXtermTerminal', () => {
  beforeEach(() => {
    built.length = 0;
    fitFails = false;
    document.head.innerHTML = '';
  });

  const host = (): HTMLElement => document.createElement('div');

  it('opens a terminal on the element it was given', () => {
    const element = host();

    createXtermTerminal(element);

    expect(built[0]?.opened).toBe(element);
  });

  it("adds xterm's stylesheet to the page", () => {
    // Without it the viewport and screen layers sit on top of each other and
    // the terminal renders as unreadable overlapping text.
    createXtermTerminal(host());

    const style = document.getElementById('signalk-portainer-xterm-styles');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('.xterm');
  });

  it('adds it once however many terminals are opened', () => {
    createXtermTerminal(host());
    createXtermTerminal(host());

    expect(document.querySelectorAll('#signalk-portainer-xterm-styles')).toHaveLength(1);
  });

  it('carries writes, focus and disposal through', () => {
    const terminal = createXtermTerminal(host());

    terminal.write('total 0\r\n');
    terminal.focus();
    terminal.dispose();

    expect(built[0]?.written).toEqual(['total 0\r\n']);
    expect(built[0]?.focused).toBe(1);
    expect(built[0]?.disposed).toBe(true);
  });

  it('reports the size xterm settled on', () => {
    const terminal = createXtermTerminal(host());
    built[0]!.cols = 132;
    built[0]!.rows = 43;

    expect(terminal.size).toEqual({ cols: 132, rows: 43 });
  });

  it('passes keystrokes and resizes to their listeners', () => {
    const typed: string[] = [];
    const sizes: { cols: number; rows: number }[] = [];
    const terminal = createXtermTerminal(host());
    terminal.onData((data) => typed.push(data));
    terminal.onResize((size) => sizes.push(size));

    built[0]?.dataListener?.('ls\n');
    built[0]?.resizeListener?.({ cols: 100, rows: 30 });

    expect(typed).toEqual(['ls\n']);
    expect(sizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it('survives a fit against an element that has no size yet', () => {
    // The dialog fits as soon as the terminal exists, which can be before the
    // modal has been laid out; an exception there would take the dialog down.
    fitFails = true;
    const terminal = createXtermTerminal(host());

    expect(() => terminal.fit()).not.toThrow();
  });

  it('loads the fit addon, which is what makes a resize possible at all', () => {
    createXtermTerminal(host());

    expect(built[0]?.addons).toHaveLength(1);
  });
});
