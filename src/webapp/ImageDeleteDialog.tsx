import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import type { DockerImage } from '../types';
import { useDialogFocus } from './dialogfocus';
import { formatBytes, shortId } from './format';

/**
 * The step between clicking Delete and deleting an image.
 *
 * It names the image the same way the other dialogs name their row, because
 * the mistake worth catching is the same one: acting on the wrong line of a
 * table where several rows look alike. Two tags of the same service differ by
 * three characters, and they are the two rows most likely to be adjacent.
 *
 * The consequence is not phrased as "this cannot be undone", which is not
 * quite true and would read as boilerplate next to the dialogs where it is.
 * An image can be fetched again — over whatever connection the boat has, which
 * offshore is none. That is the thing an operator has to weigh.
 */
export function ImageDeleteDialog({
  image,
  /** Containers holding it, once /df has said; undefined while it has not. */
  users,
  busy,
  onCancel,
  onConfirm,
}: {
  image: DockerImage;
  users?: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus lands on Cancel: a stray Enter should do nothing. The hook also
  // keeps Tab inside the dialog and hands focus back on the way out.
  const dialogRef = useDialogFocus(cancelRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Closing does not cancel a request already sent, but leaving no way out
      // of the dialog while a dropped link hangs is worse.
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const tags = image.RepoTags ?? [];
  const name = tags[0] ?? shortId(image.Id);
  // Docker refuses to remove an image by id while it carries more than one
  // tag, and the panel deletes by id. Said here rather than left to arrive as
  // a 409 the operator has to interpret.
  const multiTagged = tags.length > 1;

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-image-delete-title"
      ref={dialogRef}
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-image-delete-title">
              Delete {name}?
            </h5>
          </div>
          <div className="modal-body">
            <p className="mb-2">
              {name}{' '}
              <span className="text-muted small">
                ({shortId(image.Id)}, {formatBytes(image.Size)})
              </span>
            </p>
            <p className="mb-0">
              Its layers are deleted. Deploying from it again means pulling it back over whatever
              connection this boat has.
            </p>

            {multiTagged ? (
              <p className="text-muted small mt-3 mb-0">
                It carries {tags.length} tags — {tags.join(', ')}. Docker will refuse to delete an
                image by id while more than one tag points at it, because that would take every tag
                with it. Untag the ones you do not want in Portainer first.
              </p>
            ) : null}

            {users !== undefined && users > 0 ? (
              <p className="text-muted small mt-3 mb-0">
                {users === 1 ? '1 container is' : `${users} containers are`} using it, so Docker
                will refuse. That refusal is also what keeps the image Signal K runs from out of
                reach.
              </p>
            ) : null}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" ref={cancelRef} onClick={onCancel}>
              {busy ? 'Close' : 'Cancel'}
            </button>
            {/* Still offered when Docker is expected to refuse: the panel's
                reading of "in use" comes from a disk-usage answer taken when
                the tab opened, and refusing on the strength of that would
                block a delete that has since become possible. Docker decides. */}
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
