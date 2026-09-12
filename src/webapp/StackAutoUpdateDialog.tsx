import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useDialogFocus } from './dialogfocus';
import { autoUpdateOf, intervalProblem, webhookUrl } from './stackcontrol';
import type { Stack } from '../types';
import type { ApiError } from './api';

/**
 * A git stack's auto-update, which is Portainer redeploying it by itself.
 *
 * Two independent triggers, and a stack may have either, both or neither: a
 * timer that re-reads the repository on a schedule, and a URL that redeploys
 * it whenever something pushes to that URL. The plugin could read both before
 * this dialog existed and change neither.
 *
 * The schedule is the one that costs. Each poll is a git fetch from the boat,
 * so the interval is a bandwidth decision, not a freshness one — which is why
 * turning it off is offered as plainly as turning it on, and why nothing here
 * is enabled by default.
 */
export function StackAutoUpdateDialog({
  stack,
  baseUrl,
  busy,
  result,
  onCancel,
  onConfirm,
}: {
  stack: Stack;
  /** Where this Portainer answers, so the webhook URL can be shown in full. */
  baseUrl?: string;
  busy: boolean;
  result?: { ok: true; message: string } | { ok: false; error: ApiError };
  onCancel: () => void;
  onConfirm: (settings: {
    interval?: string;
    webhook?: boolean;
    pullImage?: boolean;
    force?: boolean;
  }) => void;
}): ReactElement {
  const held = autoUpdateOf(stack);
  const [polling, setPolling] = useState(held.interval !== undefined);
  const [interval, setInterval] = useState(held.interval ?? '30m');
  const [webhook, setWebhook] = useState(held.webhook !== undefined);
  const [pullImage, setPullImage] = useState(held.pullImage);
  const [force, setForce] = useState(held.force);
  const firstRef = useRef<HTMLInputElement>(null);

  const dialogRef = useDialogFocus(firstRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const problem = polling ? intervalProblem(interval) : undefined;
  const ready = problem === undefined && !busy;
  const anything = polling || webhook;
  const url = held.webhook === undefined ? undefined : webhookUrl(baseUrl, held.webhook);

  const submit = (): void => {
    if (!ready) return;
    onConfirm({
      ...(polling ? { interval: interval.trim() } : {}),
      ...(webhook ? { webhook: true } : {}),
      ...(anything ? { pullImage, force } : {}),
    });
  };

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-autoupdate-title"
      ref={dialogRef}
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-autoupdate-title">
              Auto-update {stack.Name}
            </h5>
          </div>
          <div className="modal-body">
            <p className="small text-muted">
              Portainer redeploys this stack from{' '}
              <span className="font-monospace">{stack.GitConfig?.URL}</span> on its own. Leave both
              off and only this panel deploys it.
            </p>

            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="portainer-autoupdate-poll"
                ref={firstRef}
                checked={polling}
                disabled={busy}
                onChange={(event) => setPolling(event.target.checked)}
              />
              <label className="form-check-label" htmlFor="portainer-autoupdate-poll">
                Check the repository on a schedule
              </label>
            </div>
            {polling ? (
              <div className="mt-2 mb-3 ms-4">
                <label
                  className="form-label small text-muted"
                  htmlFor="portainer-autoupdate-interval"
                >
                  Every
                </label>
                <input
                  id="portainer-autoupdate-interval"
                  className="form-control form-control-sm font-monospace"
                  style={{ maxWidth: '10rem' }}
                  value={interval}
                  placeholder="30m"
                  readOnly={busy}
                  aria-invalid={problem !== undefined}
                  onChange={(event) => setInterval(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submit();
                  }}
                />
                {problem ? (
                  <div className="form-text text-danger">{problem}</div>
                ) : (
                  <div className="form-text text-muted">
                    Each check is a git fetch over this link.
                  </div>
                )}
              </div>
            ) : null}

            <div className="form-check mt-2">
              <input
                className="form-check-input"
                type="checkbox"
                id="portainer-autoupdate-webhook"
                checked={webhook}
                disabled={busy}
                onChange={(event) => setWebhook(event.target.checked)}
              />
              <label className="form-check-label" htmlFor="portainer-autoupdate-webhook">
                Redeploy when a URL is called
              </label>
            </div>
            {webhook ? (
              <div className="mt-2 mb-3 ms-4">
                {url ? (
                  <>
                    <div className="form-text text-muted">
                      Call this from wherever the repository is pushed:
                    </div>
                    <code className="small user-select-all d-block text-break">{url}</code>
                  </>
                ) : held.webhook !== undefined ? (
                  <div className="form-text text-muted">
                    Webhook <span className="font-monospace">{held.webhook}</span> on this
                    Portainer&apos;s <span className="font-monospace">/api/stacks/webhooks/</span>
                    route.
                  </div>
                ) : (
                  <div className="form-text text-muted">
                    The URL is shown once Portainer has it. Anyone who has it can redeploy this
                    stack.
                  </div>
                )}
              </div>
            ) : null}

            {anything ? (
              <>
                <hr />
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="portainer-autoupdate-pull"
                    checked={pullImage}
                    disabled={busy}
                    onChange={(event) => setPullImage(event.target.checked)}
                  />
                  <label className="form-check-label small" htmlFor="portainer-autoupdate-pull">
                    Pull the images again, not just the compose file
                  </label>
                </div>
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="portainer-autoupdate-force"
                    checked={force}
                    disabled={busy}
                    onChange={(event) => setForce(event.target.checked)}
                  />
                  <label className="form-check-label small" htmlFor="portainer-autoupdate-force">
                    Redeploy even when the repository has not changed
                  </label>
                </div>
              </>
            ) : (
              <p className="small text-warning-emphasis mb-0">
                Saving with both off turns auto-update off.
              </p>
            )}

            {result ? (
              <p className={`small mt-3 mb-0 ${result.ok ? 'text-success' : 'text-danger'}`}>
                {result.ok ? result.message : result.error.message}
              </p>
            ) : null}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              {busy ? 'Close' : 'Cancel'}
            </button>
            <button
              type="button"
              className={`btn btn-${anything ? 'primary' : 'warning'}`}
              disabled={!ready}
              onClick={submit}
            >
              {busy ? 'Saving…' : anything ? 'Save' : 'Turn off'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
