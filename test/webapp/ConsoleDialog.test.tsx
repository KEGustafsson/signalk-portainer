/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DockerContainer } from '../../src/types';
import { ConsoleDialog } from '../../src/webapp/ConsoleDialog';
import type { ConsoleSocket, ConsoleSocketHandlers } from '../../src/webapp/consolesocket';
import type { Terminal, TerminalSize } from '../../src/webapp/terminal';

const container: DockerContainer = {
  Id: 'c1f0e2a3b4c5d6e7f8a9b0c1',
  Names: ['/signalk_influxdb'],
  Image: 'influxdb:2.7',
  State: 'running',
  Status: 'Up 2 hours',
  Created: 0,
} as DockerContainer;

/** The terminal the dialog would have loaded, driven by the test. */
class FakeTerminal implements Terminal {
  written: string[] = [];
  disposed = false;
  focused = 0;
  fits = 0;
  size: TerminalSize = { cols: 120, rows: 40 };
  private data: ((data: string) => void) | undefined;
  private resized: ((size: TerminalSize) => void) | undefined;

  write(data: string): void {
    // xterm's write buffer throws `Object has been disposed` once the terminal
    // has been disposed, from inside whatever called it — here, a socket
    // message handler.
    if (this.disposed) throw new Error('Object has been disposed');
    this.written.push(data);
  }
  onData(listener: (data: string) => void): void {
    this.data = listener;
  }
  onResize(listener: (size: TerminalSize) => void): void {
    this.resized = listener;
  }
  fit(): void {
    this.fits += 1;
  }
  focus(): void {
    this.focused += 1;
  }
  dispose(): void {
    this.disposed = true;
  }
  type(text: string): void {
    this.data?.(text);
  }
  resize(size: TerminalSize): void {
    this.size = size;
    this.resized?.(size);
  }
  get text(): string {
    return this.written.join('');
  }
}

/** The socket the dialog would have opened, driven by the test. */
class FakeSocket implements ConsoleSocket {
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly handlers: ConsoleSocketHandlers,
  ) {}
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
  }
}

describe('ConsoleDialog', () => {
  let fetchMock: jest.Mock;
  let terminal: FakeTerminal;
  let sockets: FakeSocket[];
  let terminalRequests: number;

  const ticketBody = { id: container.Id, ticket: 'tkt-1', session: 'ses-1', command: ['/bin/sh'] };

  const answer = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;

  beforeEach(() => {
    terminal = new FakeTerminal();
    sockets = [];
    terminalRequests = 0;
    fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/console/resize')) return answer({ cols: 120, rows: 40 });
      return answer(ticketBody);
    }) as unknown as jest.Mock;
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'boat.local:3000' },
      writable: true,
    });
  });

  const show = (props: Partial<Parameters<typeof ConsoleDialog>[0]> = {}) =>
    render(
      <ConsoleDialog
        container={container}
        instance="boat"
        onClose={props.onClose ?? (() => {})}
        terminal={async () => {
          terminalRequests += 1;
          return terminal;
        }}
        openSocket={(url, handlers) => {
          const socket = new FakeSocket(url, handlers);
          sockets.push(socket);
          return socket;
        }}
        {...props}
      />,
    );

  /** Runs the dialog forward to a shell that is connected. */
  const connected = async () => {
    const view = show();
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => sockets[0]!.handlers.onOpen());
    return view;
  };

  it('asks for a shell and opens a socket with the ticket', async () => {
    await connected();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/containers/c1f0e2a3b4c5d6e7f8a9b0c1/exec');
    expect(url).toContain('instance=boat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ command: ['/bin/sh'] });
    // Same origin as the page, and the ticket is the whole authorisation.
    expect(sockets[0]?.url).toBe(
      'ws://boat.local:3000/plugins/signalk-portainer/console?ticket=tkt-1',
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('carries what the shell prints to the terminal', async () => {
    await connected();

    act(() => sockets[0]!.handlers.onText('total 0\r\n'));

    expect(terminal.text).toBe('total 0\r\n');
  });

  it('carries what the operator types to the shell', async () => {
    await connected();

    act(() => terminal.type('ls -la\n'));

    expect(sockets[0]?.sent).toEqual(['ls -la\n']);
  });

  it('tells the plugin how big the terminal is, as soon as it is connected', async () => {
    // Docker started the shell at its own default; the browser is the only end
    // that knows the real size.
    await connected();

    await waitFor(() => {
      const resize = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes('/console/resize'),
      );
      expect(resize).toBeDefined();
      expect(JSON.parse(String((resize?.[1] as RequestInit).body))).toEqual({
        session: 'ses-1',
        cols: 120,
        rows: 40,
      });
    });
  });

  it('tells it again when the terminal changes shape', async () => {
    await connected();
    fetchMock.mockClear();

    await act(async () => terminal.resize({ cols: 80, rows: 24 }));

    await waitFor(() => {
      const resize = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes('/console/resize'),
      );
      expect(JSON.parse(String((resize?.[1] as RequestInit).body))).toMatchObject({
        cols: 80,
        rows: 24,
      });
    });
  });

  it('says nothing about a resize that failed', async () => {
    // A terminal of the wrong shape is visible on its own; an error banner
    // over a working shell helps nobody.
    await connected();
    fetchMock.mockImplementation(async () => answer({ error: 'That console is not open' }, 404));

    await act(async () => terminal.resize({ cols: 80, rows: 24 }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('explains a close code rather than showing the number', async () => {
    await connected();

    act(() => sockets[0]!.handlers.onClose(4408, ''));

    expect(screen.getByRole('status')).toHaveTextContent('idle');
    expect(screen.getByText('Ended')).toBeInTheDocument();
  });

  it('offers a new shell once one has ended', async () => {
    await connected();
    act(() => sockets[0]!.handlers.onClose(1000, ''));

    await userEvent.click(screen.getByRole('button', { name: 'New shell' }));

    await waitFor(() => expect(sockets).toHaveLength(2));
  });

  it('shows what the plugin refused, with its hint', async () => {
    fetchMock.mockImplementation(async () =>
      answer(
        {
          error: 'Refusing to open a shell in the container running Signal K',
          hint: 'enable "Allow managing the Signal K container itself"',
        },
        403,
      ),
    );

    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('running Signal K');
    expect(screen.getByRole('alert')).toHaveTextContent('Allow managing');
    expect(sockets).toHaveLength(0);
  });

  it('refuses to open a socket for an answer with no ticket in it', async () => {
    // A proxy or a login page answering with a 200 must not become a socket
    // opened with `undefined` in the query.
    fetchMock.mockImplementation(async () => answer({ id: container.Id }));

    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('did not return a console ticket');
    expect(sockets).toHaveLength(0);
  });

  it('retries after a failure', async () => {
    fetchMock.mockImplementationOnce(async () => answer({ error: 'Portainer unreachable' }, 502));
    show();
    await screen.findByRole('alert');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(sockets).toHaveLength(1));
  });

  it('opens the shell the operator picked', async () => {
    show();
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]!.handlers.onClose(1000, ''));

    await userEvent.selectOptions(screen.getByLabelText('Shell'), '/bin/bash');

    await waitFor(() => {
      const asked = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/exec'));
      expect(JSON.parse(String((asked.at(-1)?.[1] as RequestInit).body))).toEqual({
        command: ['/bin/bash'],
      });
    });
  });

  it('does not let the shell be swapped underneath a running one', async () => {
    await connected();

    expect(screen.getByLabelText('Shell')).toBeDisabled();
  });

  it('closes the socket and disposes the terminal when the dialog closes', async () => {
    // A shell whose dialog has gone still holds a process in the container and
    // one of the plugin's three console slots.
    const view = await connected();

    view.unmount();

    expect(sockets[0]?.closed).toBe(true);
    expect(terminal.disposed).toBe(true);
  });

  it('ignores output that arrives after the dialog has gone', async () => {
    // Closing the dialog closes the socket and disposes the terminal, but a
    // frame already in flight still dispatches while the socket is closing.
    // Writing it would throw out of the socket's own handler.
    const view = await connected();
    const socket = sockets[0]!;

    view.unmount();

    expect(() => socket.handlers.onText('output after close\r\n')).not.toThrow();
    expect(terminal.written).toEqual([]);
  });

  it('does not build a shell for a dialog that closed while the plugin answered', async () => {
    // The POST, the terminal's own chunk and the socket are three awaits, and
    // the dialog can close during any of them.
    let arrive!: (body: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (arrive = (body) => resolve(answer(body)))),
    );
    const view = show();

    view.unmount();
    await act(async () => arrive(ticketBody));

    expect(sockets).toHaveLength(0);
  });

  it('disposes a terminal that finished loading after the dialog closed', async () => {
    let arrive!: (terminal: Terminal) => void;
    const view = render(
      <ConsoleDialog
        container={container}
        instance="boat"
        onClose={() => {}}
        terminal={() => new Promise<Terminal>((resolve) => (arrive = resolve))}
        openSocket={(url, handlers) => {
          const socket = new FakeSocket(url, handlers);
          sockets.push(socket);
          return socket;
        }}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    view.unmount();
    await act(async () => arrive(terminal));

    expect(terminal.disposed).toBe(true);
    expect(sockets).toHaveLength(0);
  });

  it('starts over when the operator switches Portainer underneath it', async () => {
    // A container id belongs to one Portainer; relaying to the old one would
    // be a shell in a container the operator is no longer looking at.
    const view = await connected();

    view.rerender(
      <ConsoleDialog
        container={container}
        instance="shore"
        onClose={() => {}}
        terminal={async () => {
          terminalRequests += 1;
          return terminal;
        }}
        openSocket={(url, handlers) => {
          const socket = new FakeSocket(url, handlers);
          sockets.push(socket);
          return socket;
        }}
      />,
    );

    await waitFor(() => expect(sockets[0]?.closed).toBe(true));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('instance=shore'))).toBe(
        true,
      ),
    );
  });

  it('does not restart a live shell because a prop changed identity', async () => {
    // The factories arrive as props, and a caller passing them inline gets a
    // new function on every render. Treating that as a reason to reopen would
    // kill a shell somebody was typing into.
    const view = await connected();

    view.rerender(
      <ConsoleDialog
        container={container}
        instance="boat"
        onClose={() => {}}
        terminal={async () => {
          terminalRequests += 1;
          return terminal;
        }}
        openSocket={(url, handlers) => {
          const socket = new FakeSocket(url, handlers);
          sockets.push(socket);
          return socket;
        }}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminalRequests).toBe(1);
    // And the socket that was carrying the shell is still the one open.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
    expect(terminal.disposed).toBe(false);
  });

  it('gives the keyboard to the shell once it is connected', async () => {
    await connected();

    expect(terminal.focused).toBe(1);
  });

  it('closes on Escape only while there is no shell to type it into', async () => {
    // Escape is half of every arrow key; a shell that loses it is unusable.
    const onClose = jest.fn();
    show({ onClose });
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => sockets[0]!.handlers.onOpen());

    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    act(() => sockets[0]!.handlers.onClose(1000, ''));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('says what a shell can do before anyone types anything', async () => {
    await connected();

    expect(screen.getByText(/runs inside the container/)).toBeInTheDocument();
  });
});
