/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogViewer } from '../../src/webapp/LogViewer';
import { MAX_LINES } from '../../src/webapp/logstream';
import type { DockerContainer } from '../../src/types';

const container: DockerContainer = {
  Id: 'c1f0e2a3b4c5',
  Names: ['/signalk_influxdb'],
  Image: 'influxdb:2.7',
  Created: Math.floor(Date.now() / 1000) - 3600,
  State: 'running',
  Status: 'Up 1 hour',
};

/**
 * jsdom has no EventSource, so the test brings one — and it is also how the
 * test observes the thing that matters most here: whether the stream was
 * closed.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  /** Delivers one event, as the browser would. */
  emit(type: string, data?: string): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    // Wrapped in act because these arrive from outside React, exactly as the
    // real ones do: the component's state update has to be flushed.
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    });
  }

  line(stream: 'stdout' | 'stderr', text: string): void {
    this.emit('message', JSON.stringify({ stream, text }));
  }

  static get latest(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!last) throw new Error('no EventSource was opened');
    return last;
  }
}

const withLines = (...lines: { stream: string; text: string }[]) =>
  jest.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ lines }) }));

const renderViewer = (onClose = jest.fn()) =>
  render(<LogViewer container={container} instance="boat" onClose={onClose} />);

/** Turns Follow on and waits for the stream to open. */
const startFollowing = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByLabelText('Follow'));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return FakeEventSource.latest;
};

describe('LogViewer', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    global.fetch = withLines(
      { stream: 'stdout', text: 'listening on 8086' },
      { stream: 'stderr', text: 'disk almost full' },
    ) as unknown as typeof fetch;
  });

  it('loads the recent lines when it opens', async () => {
    renderViewer();

    expect(await screen.findByText('listening on 8086')).toBeInTheDocument();
    expect(screen.getByText('disk almost full')).toBeInTheDocument();
    // Not following yet: opening the viewer must not take a stream slot.
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('asks the selected instance, not the default', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    renderViewer();
    await screen.findByText('listening on 8086');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('instance=boat');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/containers/c1f0e2a3b4c5/logs?tail=200',
    );
  });

  it('colours stderr apart from ordinary output', async () => {
    renderViewer();

    const bad = await screen.findByText('disk almost full');
    const good = screen.getByText('listening on 8086');
    expect(bad).toHaveClass('text-warning');
    expect(good).not.toHaveClass('text-warning');
  });

  it('shows only stderr when asked, without going back to the server', async () => {
    const user = userEvent.setup();
    const fetchMock = global.fetch as unknown as jest.Mock;
    renderViewer();
    await screen.findByText('listening on 8086');
    const before = fetchMock.mock.calls.length;

    await user.click(screen.getByLabelText('stderr only'));

    expect(screen.queryByText('listening on 8086')).not.toBeInTheDocument();
    expect(screen.getByText('disk almost full')).toBeInTheDocument();
    // Every line already carries its stream, so filtering is free.
    expect(fetchMock.mock.calls).toHaveLength(before);
  });

  it('re-reads with the new bounds when the controls change', async () => {
    const user = userEvent.setup();
    const fetchMock = global.fetch as unknown as jest.Mock;
    renderViewer();
    await screen.findByText('listening on 8086');

    await user.selectOptions(screen.getByLabelText('Lines'), '1000');

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('tail=1000');
  });

  it('follows the stream, appending each line as it arrives', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('listening on 8086');

    const source = await startFollowing(user);
    expect(source.url).toContain('/containers/c1f0e2a3b4c5/logs/stream?tail=200');
    expect(source.url).toContain('instance=boat');

    source.emit('open');
    source.line('stdout', 'a new line');

    expect(await screen.findByText('a new line')).toBeInTheDocument();
    expect(screen.getByText(/Live/)).toBeInTheDocument();
  });

  it('closes the stream when Docker ends it, rather than reconnecting', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('listening on 8086');
    const source = await startFollowing(user);
    source.emit('open');

    source.emit('end', '{}');

    // An EventSource reconnects on its own after any disconnect. A container
    // that stopped is not coming back, so leaving it open would loop.
    await waitFor(() => expect(source.closed).toBe(true));
    expect(screen.getByText(/Stream ended/)).toBeInTheDocument();
  });

  it("reports the server's own failure and offers to try again", async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('listening on 8086');
    const source = await startFollowing(user);

    source.emit(
      'error',
      JSON.stringify({ error: 'stream failed with 502', hint: 'check the host' }),
    );

    expect(await screen.findByText('stream failed with 502')).toBeInTheDocument();
    expect(screen.getByText('check the host')).toBeInTheDocument();
    expect(source.closed).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  });

  it('says something useful when the connection simply drops', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('listening on 8086');
    const source = await startFollowing(user);

    // The browser's own error event carries no data at all.
    source.emit('error');

    expect(await screen.findByText('The log stream stopped')).toBeInTheDocument();
    expect(source.closed).toBe(true);
  });

  it('closes the stream when the viewer is closed', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const { unmount } = renderViewer(onClose);
    await screen.findByText('listening on 8086');
    const source = await startFollowing(user);

    unmount();

    // A stream left open holds one of the server's slots until the cap refuses
    // the next viewer — three per container is not many forgotten tabs.
    expect(source.closed).toBe(true);
  });

  it('closes the stream when following is turned off', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('listening on 8086');
    const source = await startFollowing(user);

    await user.click(screen.getByLabelText('Follow'));

    await waitFor(() => expect(source.closed).toBe(true));
  });

  it('reports a failed one-shot read', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ error: 'No such container', hint: 'it may have been removed' }),
      }),
    ) as unknown as typeof fetch;

    renderViewer();

    expect(await screen.findByText('No such container')).toBeInTheDocument();
    expect(screen.getByText('it may have been removed')).toBeInTheDocument();
  });

  it('offers no follow at all in a browser without EventSource', async () => {
    delete (globalThis as { EventSource?: unknown }).EventSource;

    renderViewer();
    await screen.findByText('listening on 8086');

    expect(screen.getByLabelText('Follow')).toBeDisabled();
  });

  it('downloads what is on screen', async () => {
    const user = userEvent.setup();
    // jsdom builds a Blob but will not read one back, so the parts are captured
    // on the way in.
    const written: string[] = [];
    const RealBlob = global.Blob;
    global.Blob = class extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        written.push(parts.map(String).join(''));
      }
    } as unknown as typeof Blob;
    Object.assign(URL, {
      createObjectURL: jest.fn(() => 'blob:x'),
      revokeObjectURL: jest.fn(),
    });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const anchor = jest.spyOn(document, 'createElement');

    try {
      renderViewer();
      await screen.findByText('listening on 8086');
      await user.click(screen.getByRole('button', { name: 'Download' }));

      expect(click).toHaveBeenCalled();
      expect(written[0]).toBe('listening on 8086\n[stderr] disk almost full\n');
      // Named for the container and the instance, so two downloads do not
      // land on top of each other.
      const created = anchor.mock.results
        .map((result) => result.value as HTMLElement)
        .find((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
      expect(created?.download).toMatch(/^boat-signalk_influxdb-.*\.log$/);
    } finally {
      global.Blob = RealBlob;
      click.mockRestore();
      anchor.mockRestore();
    }
  });

  it('caps a one-shot read at the same ceiling a following one has', async () => {
    // `tail` bounds the entries Docker returns, not the lines in them: one
    // entry can carry many newlines, so a 5000-entry read can be far more than
    // 5000 lines by the time it reaches the browser.
    const flood = Array.from({ length: MAX_LINES + 10 }, (_, index) => ({
      stream: 'stdout',
      text: `line-${index}`,
    }));
    global.fetch = withLines(...flood) as unknown as typeof fetch;

    renderViewer();
    // Flushed rather than polled: `findByText` re-runs a whole-document text
    // query on every mutation batch, and committing 5000 rows produces enough
    // of them to burn seconds waiting for a read that is already done.
    await act(async () => {});

    expect(screen.getByText(`line-${MAX_LINES + 9}`)).toBeInTheDocument();
    // The oldest are dropped, not rendered into a DOM that grows without bound.
    expect(screen.queryByText('line-0')).not.toBeInTheDocument();
    expect(screen.getByText(/5000 lines/)).toBeInTheDocument();
  });

  it('gives every row an identity that survives the next line', async () => {
    // The rows used to be keyed on their index in the buffer. Once the buffer
    // is full every arriving line shifts the rest down one place, so no key
    // matches and React unmounts the whole buffer and mounts a replacement for
    // it — 5000 nodes, per line. That the sequence numbers hold still across a
    // drop is proved in logstream.test.ts; what this pins is that the viewer
    // keys on them, so a row is the same DOM node before and after.
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('listening on 8086');
    const source = await startFollowing(user);
    source.emit('open');
    source.line('stdout', 'first');
    const first = screen.getByText('first');

    source.line('stdout', 'second');
    source.line('stdout', 'third');

    expect(screen.getByText('first')).toBe(first);
  });

  it('marks stderr in words, not only in colour', async () => {
    // The downloaded file has prefixed [stderr] all along; on screen the only
    // difference was a colour, which is no difference at all to an operator
    // who cannot see it.
    renderViewer();

    const bad = await screen.findByText('disk almost full');
    expect(bad).toHaveTextContent('stderr');
    expect(screen.getByText('listening on 8086')).not.toHaveTextContent('stderr');
  });

  it('announces the stream status rather than only drawing it', async () => {
    renderViewer();

    await screen.findByText('listening on 8086');

    expect(screen.getByRole('status')).toHaveTextContent('2 lines');
  });

  it('stops reading the whole buffer aloud while following', async () => {
    // role="log" makes the pane a polite live region, so a followed container
    // narrates its own output with no way to stop it short of closing the
    // dialog. The status beside the controls says what is worth saying.
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('listening on 8086');
    const pane = screen.getByRole('log');
    expect(pane).toHaveAttribute('aria-live', 'polite');

    await startFollowing(user);

    expect(screen.getByRole('log')).toHaveAttribute('aria-live', 'off');
  });

  it('gives focus back to the row it was opened from', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Logs';
    document.body.append(opener);
    opener.focus();

    const { unmount } = renderViewer();
    await screen.findByText('listening on 8086');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    unmount();

    // Not dropped on <body>, where the next Tab starts at the top of the
    // Signal K admin UI instead of at the container the operator came from.
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('listening on 8086');

    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled])',
      ),
    );
    const last = focusable[focusable.length - 1];
    last?.focus();

    await user.tab();

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderViewer(onClose);
    await screen.findByText('listening on 8086');

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});
