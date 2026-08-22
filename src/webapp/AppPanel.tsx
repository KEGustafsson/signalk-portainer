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
import { LogViewer } from './LogViewer';
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

export default function AppPanel(): ReactElement {
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

  // A tab that disappears (swarm turned off) must not leave a blank panel.
  useEffect(() => {
    if (!visibleTabs.some((candidate) => candidate.id === tab)) setTab('containers');
  }, [visibleTabs, tab]);

  // A container id belongs to one Portainer. Switching instance leaves the
  // viewer looking at an id the new one knows nothing about, so it closes
  // rather than following the switch into a 404.
  useEffect(() => {
    setViewing(undefined);
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
              onChange={(event) => setInstance(event.target.value)}
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

      {loading && !error ? <div className="text-muted">Loading…</div> : null}

      {!loading && !error ? (
        <TabBody
          tab={tab}
          payload={payload}
          actions={{ control, busyId, onAction: requestAction, onLogs: setViewing }}
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
}: {
  tab: TabId;
  payload: TabPayload;
  actions: ContainerActionsProps;
}): ReactElement {
  switch (tab) {
    case 'environments':
      return <EnvironmentsTable rows={payload.environments ?? []} />;
    case 'stacks':
      return <StacksTable rows={payload.stacks ?? []} />;
    case 'images':
      return <ImagesTable rows={payload.images ?? []} />;
    case 'volumes':
      return <VolumesTable rows={payload.volumes ?? []} />;
    case 'networks':
      return <NetworksTable rows={payload.networks ?? []} />;
    case 'services':
      return <ServicesTable rows={payload.services ?? []} />;
    case 'nodes':
      return <NodesTable rows={payload.nodes ?? []} />;
    case 'containers':
    default:
      return <ContainersTable rows={payload.containers ?? []} actions={actions} />;
  }
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(0, cause instanceof Error ? cause.message : String(cause));
}
