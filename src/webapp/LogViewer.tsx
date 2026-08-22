import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DockerContainer } from '../types';
import { ApiError, apiGet, apiUrl } from './api';
import { containerName, shortId } from './format';
import {
  DEFAULT_QUERY,
  SINCE_CHOICES,
  TAIL_CHOICES,
  appendLines,
  canFollow,
  downloadName,
  logPath,
  normalizeLines,
  parseLineEvent,
  toText,
  type LogLine,
  type LogQuery,
} from './logstream';

/**
 * A container's logs, one-shot or live.
 *
 * Live is an EventSource rather than a WebSocket for the same reason the server
 * speaks SSE: it carries the Signal K session cookie by itself. What the viewer
 * has to be careful about is the other end of that — an EventSource reconnects
 * on its own, so every way this dialog can end has to close it. A stream left
 * open holds one of the server's slots until the cap refuses the next viewer.
 */

interface Status {
  kind: 'loading' | 'live' | 'ended' | 'idle';
  detail?: string;
}

export function LogViewer({
  container,
  instance,
  onClose,
}: {
  container: DockerContainer;
  /** The selected Portainer; the stream must follow it, not the default. */
  instance: string | undefined;
  onClose: () => void;
}): ReactElement {
  const [query, setQuery] = useState<LogQuery>(DEFAULT_QUERY);
  const [follow, setFollow] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [stderrOnly, setStderrOnly] = useState(false);
  const [wrap, setWrap] = useState(true);
  /** Bumped to re-run the read without changing what is being asked for. */
  const [reloads, setReloads] = useState(0);

  const pane = useRef<HTMLDivElement>(null);
  // Auto-scroll only while the operator is at the bottom. Yanking the view back
  // down while they are reading something further up is worse than not
  // following at all.
  const pinned = useRef(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  const name = containerName(container.Names);
  const id = container.Id;
  const streaming = follow && canFollow();

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // One effect for both modes: each change of what is being asked for starts
  // over, and its cleanup is the only thing that ends the previous read —
  // whether that was a fetch or a stream, and whether this dialog is closing or
  // the operator has switched instance underneath it.
  useEffect(() => {
    setLines([]);
    setError(undefined);
    setStatus({ kind: 'loading' });
    pinned.current = true;

    if (!streaming) {
      const controller = new AbortController();
      apiGet<unknown>(logPath(id, query, false), instance, controller.signal)
        .then((body) => {
          // Through appendLines rather than straight in: `tail` bounds the
          // entries Docker returns, not the lines they contain — one entry can
          // carry many newlines — so a one-shot read is capped here by the same
          // ceiling a following one is.
          setLines(appendLines([], normalizeLines(body)));
          setStatus({ kind: 'idle' });
        })
        .catch((cause: unknown) => {
          // A cancelled request is this effect being replaced, not a failure.
          if (cause instanceof Error && cause.name === 'AbortError') return;
          setError(asApiError(cause));
          setStatus({ kind: 'idle' });
        });
      return () => controller.abort();
    }

    const source = new EventSource(apiUrl(logPath(id, query, true), instance));
    let closed = false;
    const shut = (): void => {
      closed = true;
      source.close();
    };

    source.addEventListener('open', () => setStatus({ kind: 'live' }));
    source.addEventListener('message', (event: MessageEvent<string>) => {
      const line = parseLineEvent(event.data);
      if (line) setLines((current) => appendLines(current, [line]));
    });
    source.addEventListener('end', () => {
      // Docker ended it: the container stopped. Closing here is what stops the
      // EventSource reconnecting into a loop against a container that is gone.
      shut();
      setStatus({ kind: 'ended', detail: 'the container stopped or Docker closed the stream' });
    });
    source.addEventListener('error', (event: Event) => {
      // Two different events arrive under this name: the server's own error
      // frame, which carries a message, and the browser's connection failure,
      // which carries nothing.
      const data = (event as MessageEvent<unknown>).data;
      const reported = typeof data === 'string' ? readError(data) : undefined;
      shut();
      setError(
        reported ??
          new ApiError(
            0,
            'The log stream stopped',
            'the connection to Signal K was lost, or the plugin refused the stream',
          ),
      );
      setStatus({ kind: 'ended' });
    });

    return () => {
      if (!closed) source.close();
    };
    // `reloads` is a deliberate dependency: it is how Retry re-runs this.
  }, [id, instance, query, streaming, reloads]);

  // Following the tail is the point of following; but only while the operator
  // has not scrolled away to read something.
  useEffect(() => {
    if (!pinned.current) return;
    const element = pane.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const onScroll = useCallback(() => {
    const element = pane.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinned.current = distance < 40;
  }, []);

  const shown = useMemo(
    () => (stderrOnly ? lines.filter((line) => line.stream === 'stderr') : lines),
    [lines, stderrOnly],
  );

  const download = useCallback(() => {
    const blob = new Blob([toText(shown)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName(name, instance);
    anchor.click();
    // Revoking immediately would race the click on some browsers; a turn of the
    // event loop is enough and leaves nothing held.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [shown, name, instance]);

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-logs-title"
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-xl modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-logs-title">
              Logs — {name}
            </h5>
            <span className="text-muted small ms-2">{shortId(container.Id)}</span>
          </div>

          <div className="modal-body">
            <div className="d-flex flex-wrap align-items-center gap-3 mb-2">
              <div className="d-flex align-items-center gap-1">
                <label className="form-label mb-0 small text-muted" htmlFor="portainer-logs-tail">
                  Lines
                </label>
                <select
                  id="portainer-logs-tail"
                  className="form-select form-select-sm w-auto"
                  value={query.tail}
                  onChange={(event) =>
                    setQuery((current) => ({ ...current, tail: Number(event.target.value) }))
                  }
                >
                  {TAIL_CHOICES.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              </div>

              <div className="d-flex align-items-center gap-1">
                <label className="form-label mb-0 small text-muted" htmlFor="portainer-logs-since">
                  Since
                </label>
                <select
                  id="portainer-logs-since"
                  className="form-select form-select-sm w-auto"
                  value={query.sinceSeconds}
                  onChange={(event) =>
                    setQuery((current) => ({
                      ...current,
                      sinceSeconds: Number(event.target.value),
                    }))
                  }
                >
                  {SINCE_CHOICES.map((choice) => (
                    <option key={choice.seconds} value={choice.seconds}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>

              <Check
                id="portainer-logs-timestamps"
                label="Timestamps"
                checked={query.timestamps}
                onChange={(checked) => setQuery((current) => ({ ...current, timestamps: checked }))}
              />
              <Check
                id="portainer-logs-follow"
                label="Follow"
                checked={follow}
                disabled={!canFollow()}
                title={
                  canFollow() ? undefined : 'This browser cannot follow a stream (no EventSource)'
                }
                onChange={setFollow}
              />
              <Check
                id="portainer-logs-stderr"
                label="stderr only"
                checked={stderrOnly}
                onChange={setStderrOnly}
              />
              <Check id="portainer-logs-wrap" label="Wrap" checked={wrap} onChange={setWrap} />

              <span className="small text-muted ms-auto">{describe(status, shown.length)}</span>
            </div>

            {error ? (
              <div className="alert alert-danger py-2" role="alert">
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <div>{error.message}</div>
                    {error.hint ? <div className="small mt-1">{error.hint}</div> : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    onClick={() => setReloads((count) => count + 1)}
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : null}

            <div
              className="border rounded bg-dark text-light p-2 font-monospace small"
              style={{ height: '60vh', overflow: 'auto' }}
              ref={pane}
              onScroll={onScroll}
              role="log"
              aria-label={`Logs for ${name}`}
            >
              {shown.length === 0 ? (
                <div className="text-muted">
                  {status.kind === 'loading' ? 'Loading…' : 'No log lines'}
                </div>
              ) : (
                shown.map((line, index) => (
                  <div
                    // Lines repeat and carry no id of their own; position in the
                    // buffer is what distinguishes them.
                    key={`${index}-${line.text}`}
                    className={line.stream === 'stderr' ? 'text-warning' : undefined}
                    style={{
                      whiteSpace: wrap ? 'pre-wrap' : 'pre',
                      overflowWrap: wrap ? 'anywhere' : 'normal',
                    }}
                  >
                    {line.text}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={() => setReloads((count) => count + 1)}
            >
              Reload
            </button>
            <button
              type="button"
              className="btn btn-outline-primary"
              disabled={shown.length === 0}
              onClick={download}
            >
              Download
            </button>
            <button type="button" className="btn btn-secondary" ref={closeRef} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Check({
  id,
  label,
  checked,
  onChange,
  disabled,
  title,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
}): ReactElement {
  return (
    <div className="form-check mb-0" title={title}>
      <input
        className="form-check-input"
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label className="form-check-label small" htmlFor={id}>
        {label}
      </label>
    </div>
  );
}

/** What the header says about the stream, beside the line count. */
function describe(status: Status, count: number): string {
  const lines = `${count} line${count === 1 ? '' : 's'}`;
  switch (status.kind) {
    case 'loading':
      return 'Loading…';
    case 'live':
      return `Live · ${lines}`;
    case 'ended':
      return status.detail ? `Stream ended — ${status.detail} · ${lines}` : `Stopped · ${lines}`;
    default:
      return lines;
  }
}

/** The server's own error frame, which carries what went wrong. */
function readError(data: string): ApiError | undefined {
  try {
    const body = JSON.parse(data) as { error?: unknown; hint?: unknown };
    if (typeof body.error !== 'string') return undefined;
    return new ApiError(0, body.error, typeof body.hint === 'string' ? body.hint : undefined);
  } catch {
    return undefined;
  }
}

function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(0, cause instanceof Error ? cause.message : String(cause));
}
