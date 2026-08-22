import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stack } from '../types';
import { ApiError, apiGet } from './api';
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
  const [env, setEnv] = useState<EnvVar[]>(envOf(existing));
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

  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Ignored while a deploy is in flight, for the same reason Close is
      // disabled: closing does not stop it, it only hides it.
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

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
    : content.trim().length > 0 || repositoryUrl.trim().length > 0;

  const problem = target.kind === 'new' ? nameProblem(name) : undefined;
  const creatingFromRepository = target.kind === 'new' && source === 'repository';
  const deployable =
    canDeploy &&
    !busy &&
    !loading &&
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
            ...(username ? { username, password } : {}),
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
                  readOnly={fromGit || !canDeploy}
                  value={loading ? '' : content}
                  placeholder={loading ? 'Loading…' : 'services:\n  app:\n    image: …'}
                  onChange={(event) => setContent(event.target.value)}
                />
              </div>
            )}

            <EnvEditor rows={env} readOnly={fromGit || !canDeploy} onChange={setEnv} />

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
            <button
              type="button"
              className="btn btn-secondary"
              ref={closeRef}
              disabled={busy}
              onClick={onClose}
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
  rows: EnvVar[];
  readOnly: boolean;
  onChange: (rows: EnvVar[]) => void;
}): ReactElement {
  const set = (index: number, patch: Partial<EnvVar>): void => {
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  return (
    <div>
      <div className="d-flex align-items-center justify-content-between">
        <label className="form-label small text-muted mb-1">Environment variables</label>
        {!readOnly ? (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => onChange([...rows, { name: '', value: '' }])}
          >
            Add
          </button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="text-muted small">None</div>
      ) : (
        rows.map((row, index) => (
          <div className="row g-2 mb-1" key={index}>
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
