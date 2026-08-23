import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stack } from '../types';
import { ApiError, apiGet } from './api';
import { useDialogFocus } from './dialogfocus';
import {
  envForRequest,
  envOf,
  hasChanges,
  isFromGit,
  nameProblem,
  normalizeStackFile,
  type EnvVar,
} from './stackcontrol';

/**
 * The compose file and environment of a stack, editable.
 *
 * Also the way a new stack is created, because the two are the same form: a
 * name, a source, a file and an environment. Keeping them one component keeps
 * the environment editor and the file editor from being written twice.
 *
 * A stack deployed from a repository is shown read-only. Deploying a file over
 * it would detach it from git — the server refuses that, and offering an
 * editable box that ends in a refusal would be a worse way to say so.
 */

export type StackTarget = { kind: 'existing'; stack: Stack } | { kind: 'new' };

/**
 * An environment row while it is being edited.
 *
 * `key` never leaves this file — it exists only so React reconciles the rows by
 * identity. Keyed by index, removing a row makes React reuse the DOM node that
 * held it for the row below, and the operator's focus and caret stay on that
 * node: they carry on typing into a different variable than the one they were
 * editing.
 */
interface EnvRow extends EnvVar {
  key: string;
}

/**
 * Module-level rather than a ref, so no id is ever minted during a render
 * React may go on to discard.
 */
let envRowCount = 0;

function withKeys(rows: readonly EnvVar[]): EnvRow[] {
  return rows.map((row) => ({ ...row, key: `env-${(envRowCount += 1)}` }));
}

export interface StackDeployment {
  name: string;
  content?: string;
  repositoryUrl?: string;
  reference?: string;
  composeFile?: string;
  username?: string;
  password?: string;
  env: EnvVar[];
  prune: boolean;
  pullImage: boolean;
}

export function StackEditor({
  target,
  instance,
  canDeploy,
  busy,
  result,
  onDeploy,
  onClose,
}: {
  target: StackTarget;
  instance: string | undefined;
  /** False when the configuration does not allow writes; the form is read-only. */
  canDeploy: boolean;
  busy: boolean;
  /** The outcome of the last deploy, kept here so it survives the poll. */
  result?: { ok: true; message: string } | { ok: false; error: ApiError };
  onDeploy: (deployment: StackDeployment) => void;
  onClose: () => void;
}): ReactElement {
  const existing = target.kind === 'existing' ? target.stack : undefined;
  const fromGit = existing !== undefined && isFromGit(existing);

  const [name, setName] = useState(existing?.Name ?? '');
  const [source, setSource] = useState<'file' | 'repository'>('file');
  const [content, setContent] = useState('');
  const [env, setEnv] = useState<EnvRow[]>(() => withKeys(envOf(existing)));
  const [repositoryUrl, setRepositoryUrl] = useState(existing?.GitConfig?.URL ?? '');
  const [reference, setReference] = useState(existing?.GitConfig?.ReferenceName ?? '');
  const [composeFile, setComposeFile] = useState(existing?.GitConfig?.ConfigFilePath ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [prune, setPrune] = useState(false);
  const [pullImage, setPullImage] = useState(false);
  const [loading, setLoading] = useState(existing !== undefined);
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined);
  /** What the file and environment were when they were read, for the diff. */
  const original = useRef({ content: '', env: envOf(existing) });

  /** True once Close was pressed with work in the editor, before it is thrown away. */
  const [confirmingClose, setConfirmingClose] = useState(false);

  const closeRef = useRef<HTMLButtonElement>(null);
  // Focus starts on Close, stays inside the dialog, and returns to the row the
  // editor was opened from.
  const dialogRef = useDialogFocus(closeRef);

  // The file is not in the stack list; it is a read of its own.
  useEffect(() => {
    if (!existing) return;
    const controller = new AbortController();
    apiGet<unknown>(`/stacks/${existing.Id}/file`, instance, controller.signal)
      .then((body) => {
        const file = normalizeStackFile(body);
        original.current = { content: file, env: envOf(existing) };
        setContent(file);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'AbortError') return;
        setLoadError(cause instanceof ApiError ? cause : new ApiError(0, String(cause)));
        setLoading(false);
      });
    return () => controller.abort();
  }, [existing, instance]);

  const changed = existing
    ? hasChanges(original.current, { content, env })
    : // A new stack has nothing to compare against, so "changed" is "anything
      // typed at all". Every editable field counts: an operator who filled in
      // only the environment rows has still done work that Close would throw
      // away without asking.
      name.trim().length > 0 ||
      content.trim().length > 0 ||
      repositoryUrl.trim().length > 0 ||
      env.length > 0;

  /**
   * Close, but not over unsaved work.
   *
   * The deploy path already keeps the editor open when a deploy fails, because
   * closing it would throw away work an error message asked the operator to
   * redo. Closing by hand throws away exactly the same work, and the footer has
   * been saying "Unsaved changes" the whole time — so it asks first. Not while
   * a deploy is in flight: Close is disabled then, for the same reason Escape
   * is ignored.
   */
  const requestClose = useCallback((): void => {
    if (busy) return;
    if (changed) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }, [busy, changed, onClose]);

  // Focus lands on the safe answer the moment the question appears, so a
  // stray Enter keeps the file rather than throwing it away.
  useEffect(() => {
    if (confirmingClose) closeRef.current?.focus();
  }, [confirmingClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return;
      // Escape backs out of the discard prompt rather than answering it: the
      // key that means "get me out of here" must never be the one that throws
      // the file away.
      if (confirmingClose) {
        setConfirmingClose(false);
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, confirmingClose, requestClose]);

  const problem = target.kind === 'new' ? nameProblem(name) : undefined;
  const creatingFromRepository = target.kind === 'new' && source === 'repository';
  // `loadError === undefined` is load-bearing, not belt and braces. A failed
  // read leaves `original.current` at an empty file with the editor unlocked,
  // so the first keystroke counts as a change and Deploy would PUT that
  // fragment over the stack's real compose file — replacing it, not patching
  // it, and with nothing left to recover it from.
  const deployable =
    canDeploy &&
    !busy &&
    !loading &&
    loadError === undefined &&
    problem === undefined &&
    (target.kind === 'new'
      ? creatingFromRepository
        ? repositoryUrl.trim().length > 0
        : content.trim().length > 0
      : !fromGit && changed && content.trim().length > 0);

  const deploy = useCallback(() => {
    onDeploy({
      name,
      ...(target.kind === 'new' && source === 'repository'
        ? {
            repositoryUrl: repositoryUrl.trim(),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
            ...(composeFile.trim() ? { composeFile: composeFile.trim() } : {}),
            // Sent independently: several git hosts take a token in the
            // password field and ignore the username, and gating the pair on
            // the username would drop the token silently.
            ...(username ? { username } : {}),
            ...(password ? { password } : {}),
          }
        : { content }),
      env: envForRequest(env),
      prune,
      pullImage,
    });
  }, [
    onDeploy,
    name,
    target.kind,
    source,
    repositoryUrl,
    reference,
    composeFile,
    username,
    password,
    content,
    env,
    prune,
    pullImage,
  ]);

  const title = existing ? `Stack — ${existing.Name}` : 'New stack';

  return (
    <div
      className="modal d-block"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portainer-stack-title"
      ref={dialogRef}
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div className="modal-dialog modal-xl modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title" id="portainer-stack-title">
              {title}
            </h5>
          </div>

          <div className="modal-body">
            {!canDeploy ? (
              <div className="alert alert-secondary py-2 small" role="alert">
                Stack control is disabled in the plugin configuration, so this is read-only.
              </div>
            ) : null}

            {fromGit ? (
              <div className="alert alert-info py-2 small" role="alert">
                This stack is deployed from {existing?.GitConfig?.URL}. Its file is shown as it was
                deployed and cannot be edited here — deploying a file over it would detach it from
                the repository. Change the file in git and use Redeploy.
              </div>
            ) : null}

            {loadError ? (
              <div className="alert alert-danger py-2" role="alert">
                <div>{loadError.message}</div>
                {loadError.hint ? <div className="small mt-1">{loadError.hint}</div> : null}
                {/* Said plainly, because the box below is empty and an empty
                    box is indistinguishable from a stack with no file. */}
                <div className="small mt-1">
                  The stack&apos;s compose file could not be read, so it is not shown and cannot be
                  deployed from here. Close this and try again — deploying now would replace the
                  file with whatever this box holds.
                </div>
              </div>
            ) : null}

            {result ? (
              <div
                className={`alert ${result.ok ? 'alert-success' : 'alert-danger'} py-2`}
                role="alert"
              >
                <div>{result.ok ? result.message : result.error.message}</div>
                {!result.ok && result.error.hint ? (
                  <div className="small mt-1">{result.error.hint}</div>
                ) : null}
              </div>
            ) : null}

            {target.kind === 'new' ? (
              <div className="row g-2 mb-3">
                <div className="col-md-6">
                  <label className="form-label small text-muted" htmlFor="portainer-stack-name">
                    Name
                  </label>
                  <input
                    id="portainer-stack-name"
                    className="form-control form-control-sm"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  {problem && name.length > 0 ? (
                    <div className="form-text text-danger">{problem}</div>
                  ) : null}
                </div>
                <div className="col-md-6">
                  <label className="form-label small text-muted" htmlFor="portainer-stack-source">
                    From
                  </label>
                  <select
                    id="portainer-stack-source"
                    className="form-select form-select-sm"
                    value={source}
                    onChange={(event) => setSource(event.target.value as 'file' | 'repository')}
                  >
                    <option value="file">a compose file</option>
                    <option value="repository">a git repository</option>
                  </select>
                </div>
              </div>
            ) : null}

            {creatingFromRepository ? (
              <div className="row g-2 mb-3">
                <div className="col-md-6">
                  <label className="form-label small text-muted" htmlFor="portainer-stack-repo">
                    Repository URL
                  </label>
                  <input
                    id="portainer-stack-repo"
                    className="form-control form-control-sm"
                    value={repositoryUrl}
                    onChange={(event) => setRepositoryUrl(event.target.value)}
                    placeholder="https://github.com/you/stacks"
                  />
                </div>
                <div className="col-md-3">
                  <label className="form-label small text-muted" htmlFor="portainer-stack-ref">
                    Reference
                  </label>
                  <input
                    id="portainer-stack-ref"
                    className="form-control form-control-sm"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="refs/heads/main"
                  />
                </div>
                <div className="col-md-3">
                  <label className="form-label small text-muted" htmlFor="portainer-stack-path">
                    Compose file
                  </label>
                  <input
                    id="portainer-stack-path"
                    className="form-control form-control-sm"
                    value={composeFile}
                    onChange={(event) => setComposeFile(event.target.value)}
                    placeholder="docker-compose.yml"
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label small text-muted" htmlFor="portainer-stack-user">
                    Username <span className="text-muted">(private repository only)</span>
                  </label>
                  <input
                    id="portainer-stack-user"
                    className="form-control form-control-sm"
                    autoComplete="off"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label small text-muted" htmlFor="portainer-stack-pass">
                    Password or token
                  </label>
                  <input
                    id="portainer-stack-pass"
                    className="form-control form-control-sm"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="mb-3">
                <label className="form-label small text-muted" htmlFor="portainer-stack-file">
                  Compose file
                </label>
                <textarea
                  id="portainer-stack-file"
                  className="form-control form-control-sm font-monospace"
                  rows={16}
                  spellCheck={false}
                  readOnly={fromGit || !canDeploy || loadError !== undefined}
                  value={loading ? '' : content}
                  placeholder={
                    loading
                      ? 'Loading…'
                      : loadError
                        ? 'The compose file could not be read'
                        : 'services:\n  app:\n    image: …'
                  }
                  onChange={(event) => setContent(event.target.value)}
                />
              </div>
            )}

            <EnvEditor
              rows={env}
              readOnly={fromGit || !canDeploy || loadError !== undefined}
              onChange={setEnv}
            />

            {!fromGit ? (
              <div className="d-flex gap-3 mt-3">
                <Toggle
                  id="portainer-stack-prune"
                  label="Remove services no longer in the file"
                  checked={prune}
                  disabled={!canDeploy}
                  onChange={setPrune}
                />
                <Toggle
                  id="portainer-stack-pull"
                  label="Pull images again"
                  checked={pullImage}
                  disabled={!canDeploy}
                  onChange={setPullImage}
                />
              </div>
            ) : null}
          </div>

          <div className="modal-footer">
            {existing && !fromGit ? (
              <span className="text-muted small me-auto">
                {changed ? 'Unsaved changes' : 'No changes'}
              </span>
            ) : null}
            {confirmingClose ? (
              <>
                <span className="text-danger small" role="alert">
                  Close without deploying? The edits are lost.
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  ref={closeRef}
                  onClick={() => setConfirmingClose(false)}
                >
                  Keep editing
                </button>
                <button type="button" className="btn btn-danger" onClick={onClose}>
                  Discard
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  ref={closeRef}
                  disabled={busy}
                  onClick={requestClose}
                >
                  Close
                </button>
                {!fromGit ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!deployable}
                    title={canDeploy ? undefined : 'stack control is disabled in the configuration'}
                    onClick={deploy}
                  >
                    {busy ? 'Deploying…' : existing ? 'Deploy' : 'Create'}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The stack's environment, as rows that can be added and removed. */
function EnvEditor({
  rows,
  readOnly,
  onChange,
}: {
  rows: EnvRow[];
  readOnly: boolean;
  onChange: (rows: EnvRow[]) => void;
}): ReactElement {
  const set = (index: number, patch: Partial<EnvVar>): void => {
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  return (
    // A named group rather than a bare <label>: the heading labels a set of
    // inputs, not one control, so a <label> with nothing to point at is invalid
    // HTML, does nothing when clicked, and names none of the fields below it.
    <div role="group" aria-labelledby="portainer-stack-env">
      <div className="d-flex align-items-center justify-content-between">
        <div className="form-label small text-muted mb-1" id="portainer-stack-env">
          Environment variables
        </div>
        {!readOnly ? (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => onChange([...rows, ...withKeys([{ name: '', value: '' }])])}
          >
            Add
          </button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="text-muted small">None</div>
      ) : (
        rows.map((row, index) => (
          <div className="row g-2 mb-1" key={row.key}>
            <div className="col-5">
              <input
                className="form-control form-control-sm font-monospace"
                aria-label={`Variable ${index + 1} name`}
                readOnly={readOnly}
                value={row.name}
                onChange={(event) => set(index, { name: event.target.value })}
              />
            </div>
            <div className="col-6">
              <input
                className="form-control form-control-sm font-monospace"
                aria-label={`Variable ${index + 1} value`}
                readOnly={readOnly}
                value={row.value}
                onChange={(event) => set(index, { value: event.target.value })}
              />
            </div>
            <div className="col-1">
              {!readOnly ? (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger w-100"
                  aria-label={`Remove ${row.name || `variable ${index + 1}`}`}
                  onClick={() => onChange(rows.filter((_, at) => at !== index))}
                >
                  ×
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <div className="form-check">
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
