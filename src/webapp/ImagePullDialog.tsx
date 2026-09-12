import type { ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { useDialogFocus } from './dialogfocus';
import { imageReferenceProblem } from './control';
import type { ApiError } from './api';

/** A registry the plugin offered, as the picker needs it. */
export interface RegistryOption {
  id: number;
  name: string;
  url?: string;
  authenticated: boolean;
}

/**
 * Fetching an image, and choosing which registry to fetch it from.
 *
 * The registry list is the point of this dialog. A pull of `nginx:alpine`
 * needs no login and worked before there was a picker; a pull of
 * `ghcr.io/owner/private:1.4` failed with a registry error and no way to do
 * anything about it. Portainer already holds the credentials — the plugin
 * names the registry and Portainer substitutes them, so nothing secret is
 * typed here or held by the panel.
 *
 * Anonymous stays the default. It is what Docker Hub wants, it is what most
 * boats pull, and a registry chosen by accident turns a working pull into an
 * authentication failure.
 */
export function ImagePullDialog({
  registries,
  registriesError,
  busy,
  result,
  onCancel,
  onConfirm,
}: {
  /** Empty when Portainer has none, or has not answered yet. */
  registries: readonly RegistryOption[];
  /** Why the list is missing, when it could not be read. */
  registriesError?: string;
  busy: boolean;
  /** The last attempt's outcome, kept in the dialog so it can be retried. */
  result?: { ok: true; message: string } | { ok: false; error: ApiError };
  onCancel: () => void;
  onConfirm: (request: { reference: string; registryId?: number }) => void;
}): ReactElement {
  const [reference, setReference] = useState('');
  const [registry, setRegistry] = useState('');
  const referenceRef = useRef<HTMLInputElement>(null);
  const referenceId = useId();
  const registryId = useId();

  // Focus the box the operator has to fill in, unlike the destructive dialogs
  // where focus lands on Cancel: there is nothing here to do by accident.
  const dialogRef = useDialogFocus(referenceRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const problem = imageReferenceProblem(reference);
  const ready = reference.trim().length > 0 && problem === undefined && !busy;
  const chosen = registries.find((entry) => String(entry.id) === registry);

  const submit = (): void => {
    if (!ready) return;
    onConfirm({
      reference: reference.trim(),
      ...(registry === '' ? {} : { registryId: Number(registry) }),
    });
  };

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-image-pull-title"
      ref={dialogRef}
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-image-pull-title">
              Fetch an image
            </h5>
          </div>
          <div className="modal-body">
            <div className="mb-3">
              <label className="form-label small text-muted" htmlFor={referenceId}>
                Image
              </label>
              <input
                id={referenceId}
                className="form-control form-control-sm font-monospace"
                ref={referenceRef}
                value={reference}
                placeholder="ghcr.io/owner/app:1.4"
                readOnly={busy}
                aria-invalid={problem !== undefined}
                onChange={(event) => setReference(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit();
                }}
              />
              {problem ? <div className="form-text text-danger">{problem}</div> : null}
            </div>

            <div>
              <label className="form-label small text-muted" htmlFor={registryId}>
                Registry
              </label>
              <select
                id={registryId}
                className="form-select form-select-sm"
                value={registry}
                disabled={busy || registries.length === 0}
                onChange={(event) => setRegistry(event.target.value)}
              >
                <option value="">None — pull anonymously</option>
                {registries.map((entry) => (
                  <option key={entry.id} value={String(entry.id)}>
                    {entry.name}
                    {entry.authenticated ? '' : ' (no credentials)'}
                  </option>
                ))}
              </select>
              {registriesError ? (
                <div className="form-text text-danger">
                  Portainer&apos;s registries could not be read: {registriesError}. An anonymous
                  pull still works.
                </div>
              ) : registries.length === 0 ? (
                <div className="form-text text-muted">
                  Portainer has no registries configured, so only anonymous pulls are possible.
                </div>
              ) : chosen?.authenticated === false ? (
                <div className="form-text text-muted">
                  Portainer holds no credentials for this one, so the pull is anonymous either way.
                </div>
              ) : (
                <div className="form-text text-muted">
                  Credentials stay in Portainer — the plugin only names the registry.
                </div>
              )}
            </div>

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
            <button type="button" className="btn btn-primary" disabled={!ready} onClick={submit}>
              {busy ? 'Fetching…' : 'Fetch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
