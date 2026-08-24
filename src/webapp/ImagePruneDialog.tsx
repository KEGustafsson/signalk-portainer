import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useDialogFocus } from './dialogfocus';
import { formatBytes } from './format';

/**
 * The step between clicking Reclaim space and pruning.
 *
 * Unlike every other dialog in the panel it cannot name what it will act on:
 * a prune is defined by what it finds, not by a row that was pressed. So the
 * thing it names is the difference between the two prunes on offer, which is
 * the only decision an operator actually makes here.
 *
 * The narrow one removes untagged layers, which nothing could deploy from —
 * on a boat that runs the same handful of images for a season, it is the whole
 * of what redeploys leave behind. The wide one also removes tagged images no
 * container holds, and that set includes the previous tag of anything just
 * updated: the image a rollback would have used. The checkbox is off by
 * default for the reason `removeVolumes` is.
 */
export function ImagePruneDialog({
  /** What Docker says is reclaimable, when /df has answered. */
  reclaimable,
  busy,
  onCancel,
  onConfirm,
}: {
  reclaimable?: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (options: { all: boolean }) => void;
}): ReactElement {
  const [all, setAll] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus lands on Cancel: a stray Enter should do nothing. The hook also
  // keeps Tab inside the dialog and hands focus back on the way out.
  const dialogRef = useDialogFocus(cancelRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
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
      aria-labelledby="portainer-image-prune-title"
      ref={dialogRef}
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-image-prune-title">
              Reclaim image space?
            </h5>
          </div>
          <div className="modal-body">
            <p className="mb-0">
              Untagged layers left behind by earlier deploys are deleted. Nothing can be deployed
              from those, so nothing that runs today is affected.
            </p>

            <div className="form-check mt-3">
              <input
                className="form-check-input"
                type="checkbox"
                id="portainer-prune-all"
                checked={all}
                onChange={(event) => setAll(event.target.checked)}
              />
              <label className="form-check-label" htmlFor="portainer-prune-all">
                Also delete tagged images no container is using
              </label>
            </div>
            {all ? (
              <p className="text-muted small mt-2 mb-0">
                That includes the previous tag of anything recently updated — the image a rollback
                would have used. Getting one back means pulling it again, which needs a working
                connection.
              </p>
            ) : null}

            {/* Docker's own figure, not a sum of the rows: see
                reclaimableImageBytes. Absent rather than guessed at when the
                disk-usage read has not answered. */}
            <p className="text-muted small mt-3 mb-0">
              {reclaimable === undefined
                ? 'Docker has not reported how much is reclaimable.'
                : `Docker reports ${formatBytes(reclaimable)} reclaimable across all unused images.`}
            </p>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" ref={cancelRef} onClick={onCancel}>
              {busy ? 'Close' : 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => onConfirm({ all })}
            >
              {busy ? 'Working…' : all ? 'Delete unused images' : 'Delete untagged layers'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
