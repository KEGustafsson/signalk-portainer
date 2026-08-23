import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockerContainer } from '../types';
import { ApiError, apiSend } from './api';
import {
  DEFAULT_SHELL,
  SHELL_CHOICES,
  closeMessage,
  commandFor,
  normalizeTicket,
  socketUrl,
} from './consolesession';
import { browserSocket, type ConsoleSocket, type SocketFactory } from './consolesocket';
import { containerName, shortId } from './format';
import { lazyTerminal, type Terminal, type TerminalFactory, type TerminalSize } from './terminal';

/**
 * A shell in a container.
 *
 * Two halves, and both of them can outlive the dialog: an authenticated POST
 * that creates the shell and hands back a ticket, and a WebSocket that redeems
 * it. Opening is therefore asynchronous in three places — the POST, the
 * terminal's own chunk, and the socket — and every one of them can finish after
 * the operator has closed the dialog or switched instance. A shell left behind
 * that way holds a process inside the container and one of the plugin's three
 * console slots, so each step checks whether it is still wanted and undoes
 * itself when it is not.
 */

type Phase =
  | { kind: 'starting' }
  | { kind: 'open' }
  | { kind: 'ended'; message: string }
  | { kind: 'failed'; error: ApiError };

export function ConsoleDialog({
  container,
  instance,
  onClose,
  terminal: makeTerminal = lazyTerminal,
  openSocket = browserSocket,
}: {
  container: DockerContainer;
  /** The selected Portainer; the shell must be opened on it, not the default. */
  instance: string | undefined;
  onClose: () => void;
  /** Injectable so a test needs neither a canvas nor a chunk loader. */
  terminal?: TerminalFactory;
  /** Injectable so a test needs no network. */
  openSocket?: SocketFactory;
}): ReactElement {
  const [shell, setShell] = useState<string>(DEFAULT_SHELL);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  /** Bumped to open a new shell without changing what is being asked for. */
  const [attempt, setAttempt] = useState(0);

  const host = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  /** The live terminal, so a window resize can re-measure it. */
  const screenRef = useRef<Terminal | undefined>(undefined);
  // Held in refs and kept out of the effect's dependencies. A caller passing
  // these inline — which is the natural way to write a test, and easy to reach
  // for elsewhere — would otherwise change their identity on every render, and
  // the effect would tear down a working shell and open a new one each time.
  // What a shell depends on is the container, the Portainer and the command;
  // not who supplied the constructors.
  const makeTerminalRef = useRef(makeTerminal);
  const openSocketRef = useRef(openSocket);
  // Updated in an effect rather than during render: React may discard a render
  // it never commits, and a ref written from one of those would carry a value
  // the component never actually rendered with. Declared before the shell
  // effect, so that one always reads what the latest commit passed.
  useEffect(() => {
    makeTerminalRef.current = makeTerminal;
    openSocketRef.current = openSocket;
  });

  const name = containerName(container.Names);
  const id = container.Id;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Escape belongs to the shell once it is running — it is half of every
      // arrow key — so it only closes the dialog while there is no shell.
      if (event.key === 'Escape' && phase.kind !== 'open') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, phase.kind]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    setPhase({ kind: 'starting' });
    let live = true;
    let socket: ConsoleSocket | undefined;
    let screen: Terminal | undefined;
    const controller = new AbortController();
    /** Undoes whatever has been built so far, however far along it got. */
    const abandon = (): void => {
      live = false;
      controller.abort();
      socket?.close();
      socket = undefined;
      screen?.dispose();
      screen = undefined;
      screenRef.current = undefined;
    };

    void (async () => {
      try {
        const answer = await apiSend<unknown>(
          'POST',
          `/containers/${encodeURIComponent(id)}/exec`,
          instance,
          controller.signal,
          { command: commandFor(shell) },
        );
        if (!live) return;

        const granted = normalizeTicket(answer);
        if (!granted) {
          throw new ApiError(
            0,
            'The plugin did not return a console ticket',
            'a proxy may have answered instead of the plugin',
          );
        }

        screen = await makeTerminalRef.current(element);
        // The chunk that carries the terminal can take a moment to arrive, and
        // the dialog can close while it does. The ticket is left to expire on
        // its own — thirty seconds, and it was never redeemed.
        if (!live) {
          screen.dispose();
          screen = undefined;
          return;
        }
        screen.fit();
        screenRef.current = screen;

        const opened = screen;
        socket = openSocketRef.current(socketUrl(granted.ticket), {
          onOpen: () => {
            if (!live) return;
            setPhase({ kind: 'open' });
            opened.focus();
            // Docker started this shell at its own default size; the browser
            // is the only end that knows how big the terminal really is.
            void resize(granted.session, opened.size, instance);
          },
          onText: (text) => {
            // Guarded like the other two: closing the socket does not stop a
            // frame that was already in flight, and the terminal has been
            // disposed by then — xterm throws rather than ignoring the write.
            if (!live) return;
            opened.write(text);
          },
          onClose: (code, reason) => {
            if (!live) return;
            setPhase({ kind: 'ended', message: closeMessage(code, reason) });
          },
        });

        opened.onData((data) => socket?.send(data));
        opened.onResize((size) => {
          if (live) void resize(granted.session, size, instance);
        });
      } catch (cause) {
        // A cancelled request is this effect being replaced, not a failure.
        if (cause instanceof Error && cause.name === 'AbortError') return;
        if (!live) return;
        setPhase({ kind: 'failed', error: asApiError(cause) });
      }
    })();

    return abandon;
    // `attempt` is a deliberate dependency: it is how the retry re-runs this.
  }, [id, instance, shell, attempt]);

  // The dialog is a fixed fraction of the window, so the terminal has to be
  // re-measured whenever the window changes shape. xterm reports the new size
  // itself, which is what tells Docker.
  useEffect(() => {
    if (phase.kind !== 'open') return;
    const onResize = (): void => screenRef.current?.fit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [phase.kind]);

  const restart = useCallback(() => setAttempt((count) => count + 1), []);
  const running = phase.kind === 'open';

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-console-title"
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-xl modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-console-title">
              Console — {name}
            </h5>
            <span className="text-muted small ms-2">{shortId(container.Id)}</span>
          </div>

          <div className="modal-body">
            <div className="d-flex flex-wrap align-items-center gap-3 mb-2">
              <div className="d-flex align-items-center gap-1">
                <label
                  className="form-label mb-0 small text-muted"
                  htmlFor="portainer-console-shell"
                >
                  Shell
                </label>
                <select
                  id="portainer-console-shell"
                  className="form-select form-select-sm w-auto"
                  value={shell}
                  disabled={running}
                  title={running ? 'Close this shell before opening a different one' : undefined}
                  onChange={(event) => setShell(event.target.value)}
                >
                  {SHELL_CHOICES.map((choice) => (
                    <option key={choice.label} value={choice.label}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>

              <span className="small text-muted ms-auto">{describe(phase)}</span>
            </div>

            {phase.kind === 'failed' ? (
              <div className="alert alert-danger py-2" role="alert">
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <div>{phase.error.message}</div>
                    {phase.error.hint ? <div className="small mt-1">{phase.error.hint}</div> : null}
                  </div>
                  <button type="button" className="btn btn-sm btn-outline-danger" onClick={restart}>
                    Retry
                  </button>
                </div>
              </div>
            ) : null}

            {phase.kind === 'ended' ? (
              <div className="alert alert-secondary py-2" role="status">
                <div className="d-flex justify-content-between align-items-start">
                  <div>{phase.message}</div>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    onClick={restart}
                  >
                    New shell
                  </button>
                </div>
              </div>
            ) : null}

            <div
              className="border rounded p-2"
              style={{ height: '60vh', overflow: 'hidden', background: '#101418' }}
              ref={host}
              role="group"
              aria-label={`Console for ${name}`}
            />

            <div className="form-text mt-2">
              Anything typed here runs inside the container as the user its image runs as. The shell
              ends when this dialog is closed, and after fifteen minutes with nothing typed.
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" ref={closeRef} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Tells the plugin how big the terminal is.
 *
 * Deliberately quiet: a resize that fails leaves a terminal that is the wrong
 * shape, which the operator can see, and an error banner over a working shell
 * helps nobody. The common failure is the shell having just ended, which is
 * already reported by the socket closing.
 */
async function resize(
  session: string,
  size: TerminalSize,
  instance: string | undefined,
): Promise<void> {
  try {
    await apiSend('POST', '/console/resize', instance, undefined, {
      session,
      cols: size.cols,
      rows: size.rows,
    });
  } catch {
    /* the terminal still works, at the size Docker gave it */
  }
}

/** What the header says about the shell. */
function describe(phase: Phase): string {
  switch (phase.kind) {
    case 'starting':
      return 'Opening a shell…';
    case 'open':
      return 'Connected';
    case 'ended':
      return 'Ended';
    default:
      return 'Could not open a shell';
  }
}

function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(0, cause instanceof Error ? cause.message : String(cause));
}
