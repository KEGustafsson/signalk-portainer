import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { DockerContainer } from '../types';
import {
  actionLabel,
  requiresForceToRemove,
  type ContainerAction,
  type RemoveOptions,
} from './control';
import { containerName, shortId } from './format';

/**
 * The step between clicking Stop and stopping something.
 *
 * It names the container rather than asking "are you sure?", because the
 * mistake this catches is acting on the wrong row, and a generic prompt does
 * nothing about that.
 */

export interface ConfirmRequest {
  container: DockerContainer;
  action: ContainerAction;
}

const CONSEQUENCE: Record<ContainerAction, string> = {
  start: 'It will be started.',
  stop: 'Its services stop until it is started again.',
  restart: 'Its services are interrupted while it restarts.',
  kill: 'It is sent SIGKILL immediately, with no chance to shut down cleanly.',
  pause: 'Its processes are frozen. They stop responding but keep their memory.',
  unpause: 'Its processes resume where they were frozen.',
  remove: 'The container is deleted. This cannot be undone.',
};

export function ConfirmDialog({
  request,
  busy,
  onCancel,
  onConfirm,
}: {
  request: ConfirmRequest;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (options: RemoveOptions) => void;
}): ReactElement {
  const [force, setForce] = useState(false);
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const { container, action } = request;
  const name = containerName(container.Names);
  // Paused counts as running here: Docker will not remove either without force.
  const needsForce = requiresForceToRemove(container);
  // Removing without the box ticked would be refused by Docker with a 409, so
  // the dialog does not offer to send it.
  const blocked = action === 'remove' && needsForce && !force;

  // Focus lands on Cancel, not Confirm: a stray Enter should do nothing.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Escape closes it even mid-request. Closing does not stop what was
      // already sent, and the dialog says so — but a link that drops rather
      // than resets can leave a request hanging for minutes, and a dialog with
      // no way out is worse than one the operator dismissed knowingly.
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-confirm-title"
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-confirm-title">
              {actionLabel(action)} {name}?
            </h5>
          </div>
          <div className="modal-body">
            <p className="mb-2">
              {name} <span className="text-muted small">({shortId(container.Id)})</span>
            </p>
            <p className="mb-0">{CONSEQUENCE[action]}</p>

            {action === 'remove' ? (
              <div className="mt-3">
                {needsForce ? (
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="portainer-confirm-force"
                      checked={force}
                      onChange={(event) => setForce(event.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="portainer-confirm-force">
                      Force — the container is {container.State} and cannot be removed otherwise
                    </label>
                  </div>
                ) : null}
                {/* Off by default and asked for separately: removing a
                    container is recoverable, deleting its data is not. */}
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="portainer-confirm-volumes"
                    checked={removeVolumes}
                    onChange={(event) => setRemoveVolumes(event.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="portainer-confirm-volumes">
                    Also delete its anonymous volumes — <strong>destroys their data</strong>
                  </label>
                </div>
              </div>
            ) : null}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onCancel} ref={cancelRef}>
              {busy ? 'Close' : 'Cancel'}
            </button>
            <button
              type="button"
              className={`btn ${action === 'start' || action === 'unpause' ? 'btn-success' : 'btn-danger'}`}
              onClick={() => onConfirm({ force, removeVolumes })}
              disabled={busy || blocked}
              title={
                blocked
                  ? 'Tick Force: Docker will not remove a container that is still running'
                  : undefined
              }
            >
              {busy ? 'Working…' : actionLabel(action)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
