import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import type { Stack } from '../types';
import { useDialogFocus } from './dialogfocus';
import { stackActionLabel } from './stackcontrol';

/**
 * The step between clicking Stop or Redeploy on a stack and it happening.
 *
 * Stopping a single container is already gated behind a dialog that names it.
 * Stopping a stack stops every container in it, and redeploying pulls the
 * images again and recreates the lot — both strictly more disruptive than the
 * one action that was thought worth confirming. So they are asked for the same
 * way, and for the same reason: the mistake worth catching is acting on the
 * wrong row, which no "are you sure?" would catch.
 */

/** The stack actions that interrupt something already running. */
export type ConfirmableStackAction = 'stop' | 'redeploy';

const CONSEQUENCE: Record<ConfirmableStackAction, string> = {
  stop: 'Every container in this stack stops, and its services stay down until the stack is started again.',
  redeploy:
    'The images are pulled again and every container in the stack is recreated. Its services are interrupted while that happens, and the new images are whatever the repository holds now.',
};

export function StackConfirmDialog({
  stack,
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  stack: Stack;
  action: ConfirmableStackAction;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Focus lands on Cancel: a stray Enter should do nothing. The hook keeps Tab
  // inside the dialog and hands focus back to the row on the way out.
  const dialogRef = useDialogFocus(cancelRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Escape closes it even mid-request, as the container dialog does:
      // closing does not stop what was sent, but a dialog with no way out is
      // worse than one dismissed knowingly.
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-stack-confirm-title"
      ref={dialogRef}
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-stack-confirm-title">
              {stackActionLabel(action)} {stack.Name}?
            </h5>
          </div>
          <div className="modal-body">
            <p className="mb-0">{CONSEQUENCE[action]}</p>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" ref={cancelRef} onClick={onCancel}>
              {busy ? 'Close' : 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => onConfirm()}
            >
              {busy ? 'Working…' : stackActionLabel(action)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
