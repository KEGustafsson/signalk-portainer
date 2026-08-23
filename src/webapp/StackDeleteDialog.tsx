import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import type { Stack } from '../types';

/**
 * The step between clicking Delete and deleting a stack.
 *
 * Like the container dialog, it names the thing rather than asking "are you
 * sure?" — the mistake worth catching is acting on the wrong row. Volumes are
 * asked for separately and default to off: a stack's volumes hold its data, and
 * deleting the stack says nothing about wanting the data gone.
 */
export function StackDeleteDialog({
  stack,
  busy,
  onCancel,
  onConfirm,
}: {
  stack: Stack;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus lands on Cancel: a stray Enter should do nothing.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-stack-delete-title"
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-stack-delete-title">
              Delete {stack.Name}?
            </h5>
          </div>
          <div className="modal-body">
            <p className="mb-2">
              Every container in this stack is removed, and the stack stops existing. This cannot be
              undone.
            </p>
            <p className="text-muted small mb-0">
              Its volumes are left in place. Portainer CE offers no way to remove them with the
              stack, so removing them is a separate step in Portainer itself.
            </p>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              ref={cancelRef}
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => onConfirm()}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
