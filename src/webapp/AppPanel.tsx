import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Capabilities,
  DockerContainer,
  DockerImage,
  DockerNetwork,
  DockerNode,
  DockerService,
  DockerVolume,
  Stack,
} from '../types';
import { ApiError, apiGet, apiSend } from './api';
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog';
import { ConsoleDialog } from './ConsoleDialog';
import { PanelBoundary } from './PanelBoundary';
import { LogViewer } from './LogViewer';
import { StackDeleteDialog } from './StackDeleteDialog';
import { StackEditor, type StackDeployment, type StackTarget } from './StackEditor';
import { normalizeStacks, type StackAction } from './stackcontrol';
import {
  actionLabel,
  actionRequest,
  needsConfirmation,
  normalizeControl,
  type ContainerAction,
  type ControlState,
  type RemoveOptions,
} from './control';
import { containerName } from './format';
import {
  ContainersTable,
  EnvironmentsTable,
  ImagesTable,
  NetworksTable,
  NodesTable,
  ServicesTable,
  StacksTable,
  VolumesTable,
  type ContainerActionsProps,
  type EnvironmentRow,
  type StackActionsProps,
} from './tables';

const POLL_INTERVAL_MS = 10_000;

interface InstanceSummary {
  name: string;
  isDefault: boolean;
}

type TabId =
  | 'environments'
  | 'containers'
  | 'stacks'
  | 'images'
  | 'volumes'
  | 'networks'
  | 'services'
  | 'nodes';

interface TabSpec {
  id: TabId;
  label: string;
  path: string;
  /** Only shown when the environment is a swarm. */
  swarmOnly?: boolean;
}

const TABS: TabSpec[] = [
  { id: 'environments', label: 'Environments', path: '/environments' },
  { id: 'containers', label: 'Containers', path: '/containers?all=true' },
  { id: 'stacks', label: 'Stacks', path: '/stacks' },
  { id: 'images', label: 'Images', path: '/images' },
  { id: 'volumes', label: 'Volumes', path: '/volumes' },
  { id: 'networks', label: 'Networks', path: '/networks' },
  { id: 'services', label: 'Services', path: '/swarm/services', swarmOnly: true },
  { id: 'nodes', label: 'Nodes', path: '/swarm/nodes', swarmOnly: true },
];

/** Shapes returned by the facade for each tab. */
interface TabPayload {
  environments?: EnvironmentRow[];
  containers?: DockerContainer[];
  stacks?: Stack[];
  images?: DockerImage[];
  volumes?: DockerVolume[];
  networks?: DockerNetwork[];
  services?: DockerService[];
  nodes?: DockerNode[];
}

/**
 * The panel, wrapped so a render failure stays inside it rather than taking
 * the Signal K admin UI down with it.
 */
export default function AppPanel(): ReactElement {
  return (
    <PanelBoundary>
      <Panel />
    </PanelBoundary>
  );
}

function Panel(): ReactElement {
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [instance, setInstance] = useState<string | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<Capabilities | undefined>(undefined);
  const [tab, setTab] = useState<TabId>('containers');
  const [payload, setPayload] = useState<TabPayload>({});
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [control, setControl] = useState<ControlState | undefined>(undefined);
  const [confirming, setConfirming] = useState<ConfirmRequest | undefined>(undefined);
  // The container whose logs are open, if any.
  const [viewing, setViewing] = useState<DockerContainer | undefined>(undefined);
  const [shelling, setShelling] = useState<DockerContainer | undefined>(undefined);
  // The stack open in the editor — an existing one, or a new one being created.
  const [editing, setEditing] = useState<StackTarget | undefined>(undefined);
  const [deleting, setDeleting] = useState<Stack | undefined>(undefined);
  const [busyStack, setBusyStack] = useState<number | undefined>(undefined);
  // Kept apart from the poll's error for the same reason a container action is.
  const [stackResult, setStackResult] = useState<
    { ok: true; message: string } | { ok: false; error: ApiError } | undefined
  >(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  // Kept apart from `error`: the poll clears that one on its next success, and
  // a refused action is exactly what the operator still needs to read.
  const [actionResult, setActionResult] = useState<
    { ok: true; message: string } | { ok: false; error: ApiError } | undefined
  >(undefined);

  // Keeps a slow response from overwriting the results of a later request when
  // the operator switches tab or instance while one is still in flight.
  const requestSeq = useRef(0);
  // A stalled request would otherwise stay open while every poll starts
  // another, so each new request cancels the one before it.
  const inFlight = useRef<AbortController | undefined>(undefined);
  // Which instance is selected right now, readable from inside an async action
  // that started before the operator switched.
  const selected = useRef<string | undefined>(instance);
  selected.current = instance;

  const activeTab = useMemo(
    () => TABS.find((candidate) => candidate.id === tab) ?? TABS[1]!,
    [tab],
  );

  const visibleTabs = useMemo(
    () => TABS.filter((candidate) => !candidate.swarmOnly || capabilities?.swarm),
    [capabilities],
  );

  useEffect(() => {
    let cancelled = false;
    apiGet<{ instances: InstanceSummary[] }>('/instances')
      .then((body) => {
        if (cancelled) return;
        setInstances(body.instances);
        setInstance(body.instances.find((entry) => entry.isDefault)?.name);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(asApiError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (instances.length === 0) return;
    let cancelled = false;
    apiGet<{ capabilities: Capabilities }>('/capabilities', instance)
      .then((body) => {
        if (!cancelled) setCapabilities(body.capabilities);
      })
      .catch(() => {
        // A capability probe failure is not fatal: it only hides the swarm
        // tabs, and the tab fetch below will surface the real error.
        if (!cancelled) setCapabilities(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [instance, instances.length]);

  useEffect(() => {
    if (instances.length === 0) return;
    let cancelled = false;
    apiGet<unknown>('/control', instance)
      .then((body) => {
        if (!cancelled) setControl(normalizeControl(body));
      })
      .catch(() => {
        // Without an answer the panel offers nothing rather than guessing: the
        // buttons stay disabled and say they are waiting on the plugin.
        if (!cancelled) setControl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [instance, instances.length]);

  const load = useCallback(async (): Promise<void> => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const seq = (requestSeq.current += 1);
    try {
      const body = await apiGet<TabPayload>(activeTab.path, instance, controller.signal);
      if (seq !== requestSeq.current) return;
      setPayload(body);
      setError(undefined);
    } catch (cause) {
      // A cancelled request is expected, not a failure to report.
      if (isAbort(cause) || seq !== requestSeq.current) return;
      setError(asApiError(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [activeTab.path, instance]);

  useEffect(() => {
    if (instances.length === 0) return;
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      // Unmounting or switching away must not leave a request open.
      inFlight.current?.abort();
    };
  }, [load, instances.length]);

  const runAction = useCallback(
    async (
      container: DockerContainer,
      action: ContainerAction,
      options: RemoveOptions,
    ): Promise<void> => {
      setBusyId(container.Id);
      setActionResult(undefined);
      const startedOn = instance;
      const { method, path } = actionRequest(container.Id, action, options);
      try {
        await apiSend(method, path, startedOn);
        setConfirming(undefined);
        setActionResult({
          ok: true,
          message: `${actionLabel(action)} ${containerName(container.Names)}: done`,
        });
        // Straight to a fresh read: the table is the confirmation that it
        // worked, and the 10s poll is too slow to feel like one.
        //
        // Unless the operator has switched instance while this was in flight:
        // `load` is bound to the instance the action started on, and running it
        // now would abort the new instance's request and paint its table with
        // the old one's containers. The switch has already started its own load.
        if (selected.current === startedOn) await load();
      } catch (cause) {
        setConfirming(undefined);
        setActionResult({ ok: false, error: asApiError(cause) });
      } finally {
        setBusyId(undefined);
      }
    },
    [instance, load],
  );

  const requestAction = useCallback(
    (container: DockerContainer, action: ContainerAction): void => {
      setActionResult(undefined);
      if (needsConfirmation(action)) {
        setConfirming({ container, action });
        return;
      }
      void runAction(container, action, { force: false, removeVolumes: false });
    },
    [runAction],
  );

  const runStack = useCallback(
    async (stack: Stack, run: () => Promise<unknown>, done: string): Promise<{ ok: boolean }> => {
      setBusyStack(stack.Id);
      setStackResult(undefined);
      const startedOn = instance;
      try {
        await run();
        setStackResult({ ok: true, message: `${stack.Name}: ${done}` });
        // Straight to a fresh read, as a container action does — the table is
        // the confirmation, and the 10s poll is too slow to feel like one.
        if (selected.current === startedOn) await load();
        return { ok: true };
      } catch (cause) {
        setStackResult({ ok: false, error: asApiError(cause) });
        return { ok: false };
      } finally {
        setBusyStack(undefined);
      }
    },
    [instance, load],
  );

  const requestStackAction = useCallback(
    (stack: Stack, action: StackAction): void => {
      setStackResult(undefined);
      if (action === 'edit') {
        setEditing({ kind: 'existing', stack });
        return;
      }
      if (action === 'delete') {
        setDeleting(stack);
        return;
      }
      // Spelled out rather than derived: "start" + "ped" is not a word.
      const done = action === 'redeploy' ? 'redeployed' : action === 'stop' ? 'stopped' : 'started';
      void runStack(stack, () => apiSend('POST', `/stacks/${stack.Id}/${action}`, instance), done);
    },
    [instance, runStack],
  );

  const deployStack = useCallback(
    async (deployment: StackDeployment): Promise<void> => {
      const target = editing;
      if (!target) return;
      const body = {
        env: deployment.env,
        prune: deployment.prune,
        pullImage: deployment.pullImage,
        ...(deployment.content !== undefined ? { content: deployment.content } : {}),
        ...(deployment.repositoryUrl !== undefined
          ? {
              name: deployment.name,
              repositoryUrl: deployment.repositoryUrl,
              ...(deployment.reference ? { reference: deployment.reference } : {}),
              ...(deployment.composeFile ? { composeFile: deployment.composeFile } : {}),
              ...(deployment.username ? { username: deployment.username } : {}),
              ...(deployment.password ? { password: deployment.password } : {}),
            }
          : {}),
        ...(target.kind === 'new' ? { name: deployment.name } : {}),
      };

      const stack =
        target.kind === 'existing' ? target.stack : ({ Id: -1, Name: deployment.name } as Stack);

      const outcome = await runStack(
        stack,
        () =>
          target.kind === 'existing'
            ? apiSend('PUT', `/stacks/${target.stack.Id}`, instance, undefined, body)
            : apiSend('POST', '/stacks', instance, undefined, body),
        target.kind === 'existing' ? 'deployed' : 'created',
      );
      // The editor stays open on failure, holding the file the operator wrote:
      // closing it would throw away work an error message asked them to redo.
      if (outcome.ok) setEditing(undefined);
    },
    [editing, instance, runStack],
  );

  // A tab that disappears (swarm turned off) must not leave a blank panel.
  useEffect(() => {
    if (!visibleTabs.some((candidate) => candidate.id === tab)) setTab('containers');
  }, [visibleTabs, tab]);

  /**
   * Closes everything that is looking at one Portainer's ids.
   *
   * A container id, and a stack id, belong to the instance they came from: the
   * next one knows nothing about them.
   */
  const closeInstanceViews = useCallback(() => {
    setViewing(undefined);
    setShelling(undefined);
    setEditing(undefined);
    setDeleting(undefined);
    setStackResult(undefined);
  }, []);

  /**
   * Switches Portainer, closing those views first.
   *
   * The order is the point. These dialogs are children of this component, and
   * React runs a child's effects before its parent's, so setting the instance
   * and leaving the closing to the effect below lets a dialog re-run its own
   * effect against the new instance on the way out — asking the newly selected
   * Portainer for a shell in, or the logs of, a container that belongs to the
   * old one. Closing them first means there is no dialog left to ask.
   */
  const selectInstance = useCallback(
    (name: string) => {
      closeInstanceViews();
      setInstance(name);
    },
    [closeInstanceViews],
  );

  // The backstop, for an instance that changes any other way — the first one
  // being chosen once /instances answers, say.
  useEffect(() => {
    closeInstanceViews();
    // Deliberately only on a change of instance: this closes dialogs, and
    // re-running it for any other reason would close one the operator opened.
  }, [instance]);

  return (
    <div className="p-3">
      <div className="d-flex align-items-center justify-content-between mb-3">
        <h5 className="mb-0">Portainer</h5>
        {instances.length > 1 ? (
          <div className="d-flex align-items-center gap-2">
            <label className="form-label mb-0 small text-muted" htmlFor="portainer-instance">
              Instance
            </label>
            <select
              id="portainer-instance"
              className="form-select form-select-sm w-auto"
              value={instance ?? ''}
              onChange={(event) => selectInstance(event.target.value)}
            >
              {instances.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <ul className="nav nav-tabs mb-3">
        {visibleTabs.map((candidate) => (
          <li className="nav-item" key={candidate.id}>
            <button
              type="button"
              className={`nav-link ${candidate.id === tab ? 'active' : ''}`}
              onClick={() => setTab(candidate.id)}
            >
              {candidate.label}
            </button>
          </li>
        ))}
      </ul>

      {control?.self.warning ? (
        <div className="alert alert-warning py-2 small" role="alert">
          {control.self.warning}
        </div>
      ) : null}

      {error ? (
        <div className="alert alert-danger" role="alert">
          <div>{error.message}</div>
          {error.hint ? <div className="small mt-1">{error.hint}</div> : null}
        </div>
      ) : null}

      {actionResult ? (
        <div
          className={`alert ${actionResult.ok ? 'alert-success' : 'alert-danger'} d-flex justify-content-between align-items-start`}
          role="alert"
        >
          <div>
            <div>{actionResult.ok ? actionResult.message : actionResult.error.message}</div>
            {!actionResult.ok && actionResult.error.hint ? (
              <div className="small mt-1">{actionResult.error.hint}</div>
            ) : null}
          </div>
          <button
            type="button"
            className="btn-close"
            aria-label="Dismiss"
            onClick={() => setActionResult(undefined)}
          />
        </div>
      ) : null}

      {stackResult && !editing ? (
        <div
          className={`alert ${stackResult.ok ? 'alert-success' : 'alert-danger'} d-flex justify-content-between align-items-start`}
          role="alert"
        >
          <div>
            <div>{stackResult.ok ? stackResult.message : stackResult.error.message}</div>
            {!stackResult.ok && stackResult.error.hint ? (
              <div className="small mt-1">{stackResult.error.hint}</div>
            ) : null}
          </div>
          <button
            type="button"
            className="btn-close"
            aria-label="Dismiss"
            onClick={() => setStackResult(undefined)}
          />
        </div>
      ) : null}

      {loading && !error ? <div className="text-muted">Loading…</div> : null}

      {!loading && !error ? (
        <TabBody
          tab={tab}
          payload={payload}
          actions={{
            control,
            busyId,
            onAction: requestAction,
            onLogs: setViewing,
            // Absent entirely, rather than disabled, on a server that cannot
            // serve a console at all: there is nothing an operator could do
            // about it, so a permanently dead button is only clutter.
            ...(control?.console.available ? { onConsole: setShelling } : {}),
          }}
          stackActions={{ control, busyId: busyStack, onAction: requestStackAction }}
          onNewStack={() => {
            setStackResult(undefined);
            setEditing({ kind: 'new' });
          }}
        />
      ) : null}

      {viewing ? (
        <LogViewer
          // Keyed by container: opening a different one starts a new viewer
          // rather than reusing this one's buffer and its stream.
          key={viewing.Id}
          container={viewing}
          instance={instance}
          onClose={() => setViewing(undefined)}
        />
      ) : null}

      {shelling ? (
        <ConsoleDialog
          // Keyed by container: opening a shell in a different one starts a
          // new dialog rather than reusing this one's socket.
          key={shelling.Id}
          container={shelling}
          instance={instance}
          onClose={() => setShelling(undefined)}
        />
      ) : null}

      {editing ? (
        <StackEditor
          key={editing.kind === 'existing' ? editing.stack.Id : 'new'}
          target={editing}
          instance={instance}
          canDeploy={control?.allowPutControl === true}
          busy={busyStack !== undefined}
          result={stackResult}
          onDeploy={(deployment) => void deployStack(deployment)}
          onClose={() => setEditing(undefined)}
        />
      ) : null}

      {deleting ? (
        <StackDeleteDialog
          stack={deleting}
          busy={busyStack === deleting.Id}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            void runStack(
              deleting,
              () => apiSend('DELETE', `/stacks/${deleting.Id}`, instance),
              'deleted',
            ).then(() => setDeleting(undefined));
          }}
        />
      ) : null}

      {confirming ? (
        <ConfirmDialog
          request={confirming}
          busy={busyId === confirming.container.Id}
          onCancel={() => setConfirming(undefined)}
          onConfirm={(options) => void runAction(confirming.container, confirming.action, options)}
        />
      ) : null}
    </div>
  );
}

function TabBody({
  tab,
  payload,
  actions,
  stackActions,
  onNewStack,
}: {
  tab: TabId;
  payload: TabPayload;
  actions: ContainerActionsProps;
  stackActions: StackActionsProps;
  onNewStack: () => void;
}): ReactElement {
  switch (tab) {
    case 'environments':
      return <EnvironmentsTable rows={payload.environments ?? []} />;
    case 'stacks':
      return (
        <div>
          <div className="d-flex justify-content-end mb-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!stackActions.control?.allowPutControl}
              title={
                stackActions.control?.allowPutControl
                  ? undefined
                  : 'stack control is disabled; enable "Allow Signal K PUT control" in the plugin configuration'
              }
              onClick={onNewStack}
            >
              New stack
            </button>
          </div>
          {/* Normalized rather than trusted: these rows carry the ids that
              destructive actions are sent with. */}
          <StacksTable rows={normalizeStacks(payload)} actions={stackActions} />
        </div>
      );
    case 'images':
      return <ImagesTable rows={rowsOf(payload.images)} />;
    case 'volumes':
      return <VolumesTable rows={rowsOf(payload.volumes)} />;
    case 'networks':
      return <NetworksTable rows={rowsOf(payload.networks)} />;
    case 'services':
      return <ServicesTable rows={rowsOf(payload.services)} />;
    case 'nodes':
      return <NodesTable rows={rowsOf(payload.nodes)} />;
    case 'containers':
    default:
      return <ContainersTable rows={rowsOf(payload.containers)} actions={actions} />;
  }
}

/**
 * A tab's rows, or none.
 *
 * `apiGet<TabPayload>` casts whatever came back; nothing checks it. A truthy
 * non-array — `{}` from a proxy, an error body from a future facade change —
 * skips the `?? []` and throws from `.map` during render. The panel is a guest
 * inside the Signal K admin UI, and a throw during render takes the host's
 * tree down with it, not just this panel.
 */
function rowsOf<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(0, cause instanceof Error ? cause.message : String(cause));
}
