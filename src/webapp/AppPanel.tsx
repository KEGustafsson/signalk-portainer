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
import { StackConfirmDialog, type ConfirmableStackAction } from './StackConfirmDialog';
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
  GatedButton,
  ImagesTable,
  NetworksTable,
  NodesTable,
  ServicesTable,
  StacksTable,
  VolumesTable,
  type ContainerActionsProps,
  type EnvironmentActionsProps,
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

/** Where the panel opens, and where it falls back to. */
const LANDING_TAB: TabId = 'environments';

/** The one panel every tab draws into, named so each tab can point at it. */
const TAB_PANEL_ID = 'portainer-tabpanel';

function tabButtonId(id: TabId): string {
  return `portainer-tab-${id}`;
}

/** Shapes returned by the facade for each tab. */
interface TabPayload {
  environments?: EnvironmentRow[];
  /** Only from /environments: which one this instance is working against. */
  selected?: number | null;
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
  const [environments, setEnvironments] = useState<EnvironmentRow[]>([]);
  // null is a real state, not "not loaded yet": Portainer has several
  // environments and nobody has chosen one. undefined means the question has
  // not been asked yet.
  const [environment, setEnvironment] = useState<number | null | undefined>(undefined);
  const [switching, setSwitching] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | undefined>(undefined);
  // The environments are the landing page: which Docker host the panel is
  // about is the first thing an operator needs to see, and on a Portainer with
  // several it is the first thing they have to answer.
  const [tab, setTab] = useState<TabId>(LANDING_TAB);
  const [payload, setPayload] = useState<TabPayload>({});
  const [error, setError] = useState<ApiError | undefined>(undefined);
  // Kept apart from `error` for the reason the panel keeps every other outcome
  // apart from it: `load` clears `error` on its next success, and the reads
  // that set this one are not the reads `load` makes. A refused environment
  // switch cleared by a poll is the worst case — the poll succeeded against
  // the environment the operator failed to leave, so the banner disappears,
  // the selection has not moved, and the switch reads as having worked.
  const [setupError, setSetupError] = useState<ApiError | undefined>(undefined);
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
  // The stack action waiting to be confirmed, if any.
  const [confirmingStack, setConfirmingStack] = useState<
    { stack: Stack; action: ConfirmableStackAction } | undefined
  >(undefined);
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
  // Written from an effect rather than during render: React may discard a
  // render it never commits, and a ref written from one of those would carry a
  // value the component never actually rendered with. This ref is the guard
  // that stops a finished action repainting the wrong instance's table, so it
  // has to hold what was committed, not what was merely attempted.
  useEffect(() => {
    selected.current = instance;
  });

  const activeTab = useMemo(
    () => TABS.find((candidate) => candidate.id === tab) ?? TABS[0]!,
    [tab],
  );

  /**
   * Several environments, none chosen. Distinct from "still loading": the
   * panel has an answer, and the answer is that the operator has to pick.
   */
  const needsEnvironment = environment === null && environments.length > 1;

  /** The environment in use, once there is one and its row has been read. */
  const chosen = environments.find((entry) => entry.id === environment);

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
        if (cancelled) return;
        setSetupError(asApiError(cause));
        // Nothing else will run: every read below waits on an instance. Left
        // true, the panel sits under "Loading…" forever beside an error that
        // says it has already given up.
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Read on its own rather than with the tab payload: every other read needs a
   * chosen environment, and this is the one that lets the operator choose.
   */
  const loadEnvironments = useCallback(
    async (signal?: AbortSignal, wanted: () => boolean = () => true): Promise<void> => {
      const body = await apiGet<{ environments: EnvironmentRow[]; selected: number | null }>(
        '/environments',
        instance,
        signal,
      );
      // An answer belonging to an instance the operator has already left must
      // not paint the picker: the header would name the wrong Docker host, and
      // the Environments tab would then offer the other instance's ids —
      // pressing one sends that id to this instance.
      if (!wanted()) return;
      // Through the same guard the rest of the panel reads rows with: `??`
      // stops at null and undefined, and a truthy non-array walks straight into
      // `rows.map` during render.
      setEnvironments(rowsOf(body.environments));
      // `?? null` rather than leaving it undefined: undefined means "not asked
      // yet" and holds the panel back, and an answer that omits the field would
      // otherwise hold it back for good.
      setEnvironment(body.selected ?? null);
    },
    [instance],
  );

  useEffect(() => {
    if (instances.length === 0) return;
    let cancelled = false;
    // Cancelled as well as guarded: a read left open against the instance the
    // operator has left is one more request the browser is waiting on.
    const controller = new AbortController();
    setEnvironment(undefined);
    loadEnvironments(controller.signal, () => !cancelled)
      .then(() => {
        if (!cancelled) setSetupError(undefined);
      })
      .catch((cause: unknown) => {
        if (cancelled || isAbort(cause)) return;
        setSetupError(asApiError(cause));
        // Not left as undefined: that state stops the panel from loading
        // anything, and a picker that could not be read is no reason to keep the
        // rest of it dark. The tab read runs and reports whatever is really
        // wrong.
        setEnvironment(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [loadEnvironments, instances.length]);

  useEffect(() => {
    if (instances.length === 0) return;
    // docker/info is read through the environment, so it has nothing to answer
    // while the choice is still open.
    if (environment === undefined || needsEnvironment) return;
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
  }, [instance, instances.length, environment, needsEnvironment]);

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
      // This tab reads the very list the choice is made from, so one read keeps
      // both current: an environment that goes down, or a choice made from
      // another browser, shows up without a second request.
      if (activeTab.id === 'environments') {
        setEnvironments(rowsOf(body.environments));
        setEnvironment(body.selected ?? null);
      }
      setError(undefined);
    } catch (cause) {
      // A cancelled request is expected, not a failure to report.
      if (isAbort(cause) || seq !== requestSeq.current) return;
      setError(asApiError(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [activeTab.id, activeTab.path, instance]);

  useEffect(() => {
    if (instances.length === 0) return;
    // Every other tab read is scoped to an environment, so polling while the
    // choice is still open only produces the same refusal ten seconds apart.
    // The Environments tab is the exception, and the way out: it is the list
    // the choice is made from. A resolved-to-nothing environment with nothing
    // to choose from is a different thing entirely, and is left to the tab
    // read so the real error is the one that surfaces.
    // Still loading, and it must keep saying so: the answer to "which
    // environment" has not arrived, so a table drawn now would show "No
    // containers" — which reads as a Docker host with nothing on it rather
    // than as a slow link, and there is no way for the operator to tell those
    // two apart afterwards.
    if (environment === undefined) return;
    if (needsEnvironment && tab !== LANDING_TAB) {
      // This one really has finished: the panel has its answer, and the answer
      // is that the operator has to choose before anything can be read.
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      // Unmounting or switching away must not leave a request open.
      inFlight.current?.abort();
    };
  }, [load, instances.length, environment, needsEnvironment, tab]);

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

  /** Sends one of the simple stack verbs, once there is nothing left to ask. */
  const sendStackAction = useCallback(
    (stack: Stack, action: 'start' | ConfirmableStackAction): void => {
      // Spelled out rather than derived: "start" + "ped" is not a word.
      const done = action === 'redeploy' ? 'redeployed' : action === 'stop' ? 'stopped' : 'started';
      void runStack(
        stack,
        () => apiSend('POST', `/stacks/${stack.Id}/${action}`, instance),
        done,
      ).then(() => setConfirmingStack(undefined));
    },
    [instance, runStack],
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
      // Stopping a stack stops every container in it, and redeploying pulls
      // and recreates them — both more disruptive than stopping one container,
      // which the panel already refuses to do without asking. Start is the
      // exception, as it is for a container: its worst case is that nothing
      // happens.
      if (action === 'stop' || action === 'redeploy') {
        setConfirmingStack({ stack, action });
        return;
      }
      sendStackAction(stack, action);
    },
    [sendStackAction],
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
    if (!visibleTabs.some((candidate) => candidate.id === tab)) setTab(LANDING_TAB);
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
    setConfirmingStack(undefined);
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

  /**
   * Switches the environment this instance works against. Saved server-side
   * rather than held in this tab: the delta poller and the watchdog work
   * against the same client, and a choice only the browser knew about would
   * leave them publishing nothing.
   */
  const selectEnvironment = useCallback(
    async (id: number): Promise<void> => {
      closeInstanceViews();
      setSwitching(true);
      // Dropped rather than left on screen: they describe the environment
      // being switched away from, and reading them against the new one would
      // be actively misleading.
      setPayload({});
      setError(undefined);
      setSetupError(undefined);
      setActionResult(undefined);
      setStackResult(undefined);
      const startedOn = instance;
      try {
        await apiSend<{ selected: number; warning?: string }>(
          'PUT',
          '/environment',
          instance,
          undefined,
          { id },
        );
        setEnvironment(id);
        // Guarded the same way an action's refresh is: if the operator has
        // switched Portainer while the PUT was in flight, this answer belongs
        // to the one they left.
        await loadEnvironments(undefined, () => selected.current === startedOn);
      } catch (cause) {
        // Into the setup sink, never into `error`: the next poll succeeds
        // against the environment that was never left, and would clear a
        // refusal the operator has to see.
        setSetupError(asApiError(cause));
      } finally {
        setSwitching(false);
      }
    },
    [closeInstanceViews, instance, loadEnvironments],
  );

  // The backstop, for an instance that changes any other way — the first one
  // being chosen once /instances answers, say.
  useEffect(() => {
    closeInstanceViews();
    // What the last Portainer allowed says nothing about the next one. Left in
    // place, Remove and Delete stay enabled and the swarm tabs stay visible
    // until the new reads land, and a press inside that window ends in a 403
    // instead of on a button that explains itself. Cleared here rather than in
    // closeInstanceViews, which also runs on an environment switch — where
    // neither read re-runs, and clearing them would disable the panel for good.
    setControl(undefined);
    setCapabilities(undefined);
    // Deliberately only on a change of instance: this closes dialogs, and
    // re-running it for any other reason would close one the operator opened.
  }, [instance]);

  /**
   * The arrow keys, Home and End across the tab strip.
   *
   * The strip holds one tab stop, so moving the selection has to carry focus
   * with it — otherwise focus is left on a tab that is no longer selected and
   * no longer in the tab order. The element is focused before the state
   * changes, while it is certainly still on screen.
   */
  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      const at = visibleTabs.findIndex((candidate) => candidate.id === tab);
      if (at < 0) return;
      const last = visibleTabs.length - 1;
      const to =
        event.key === 'ArrowRight'
          ? (at + 1) % visibleTabs.length
          : event.key === 'ArrowLeft'
            ? (at + last) % visibleTabs.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? last
                : undefined;
      const next = to === undefined ? undefined : visibleTabs[to];
      if (!next) return;
      event.preventDefault();
      document.getElementById(tabButtonId(next.id))?.focus();
      setTab(next.id);
    },
    [tab, visibleTabs],
  );

  return (
    <div className="p-3">
      <div className="d-flex align-items-center justify-content-between mb-3">
        <h5 className="mb-0">Portainer</h5>
        <div className="d-flex align-items-center gap-3">
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

          {/* What is being worked on, not a control: the choice itself is made
              by pressing a row on the Environments tab. Worth the space only
              where there is more than one, since a Portainer with one resolves
              it without being asked. */}
          {environments.length > 1 && chosen ? (
            <span className="small text-muted">
              Environment <span className="fw-semibold">{chosen.name}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* A real tablist, not a row of buttons that happen to look like one:
          the Bootstrap `active` class is a colour, and which tab is open is
          the single most important thing about the state of this panel. */}
      <ul className="nav nav-tabs mb-3" role="tablist">
        {visibleTabs.map((candidate) => (
          <li className="nav-item" key={candidate.id} role="presentation">
            <button
              type="button"
              role="tab"
              id={tabButtonId(candidate.id)}
              aria-selected={candidate.id === tab}
              aria-controls={TAB_PANEL_ID}
              // One tab stop for the whole strip, as a tablist has: Tab reaches
              // the tabs, the arrow keys move between them.
              tabIndex={candidate.id === tab ? 0 : -1}
              className={`nav-link ${candidate.id === tab ? 'active' : ''}`}
              onKeyDown={onTabKeyDown}
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

      {/* Dismissed by hand rather than by the next poll: this one outlives a
          successful read, because a successful read is not an answer to it. */}
      {setupError ? (
        <div
          className="alert alert-danger d-flex justify-content-between align-items-start"
          role="alert"
        >
          <div>
            <div>{setupError.message}</div>
            {setupError.hint ? <div className="small mt-1">{setupError.hint}</div> : null}
          </div>
          <button
            type="button"
            className="btn-close"
            aria-label="Dismiss"
            onClick={() => setSetupError(undefined)}
          />
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

      {/* The first-run state, not a failure: Portainer has several environments
          and the panel will not pick a Docker host on the operator's behalf.
          Restarting a container on the wrong one is the thing being avoided. */}
      {needsEnvironment ? (
        <div className="alert alert-info" role="alert">
          <div>Choose an environment to continue</div>
          <div className="small mt-1">
            This Portainer manages {environments.length} environments. Press the one this Signal K
            server should work with — it is remembered, so this is asked once.
          </div>
        </div>
      ) : null}

      {/* Announced, not just drawn: both of these are the panel's answer to a
          press, and a screen reader is told nothing by a bare div. */}
      {switching ? (
        <div className="text-muted" role="status">
          Switching environment…
        </div>
      ) : null}

      {loading && !error && !needsEnvironment ? (
        <div className="text-muted" role="status">
          Loading…
        </div>
      ) : null}

      {/* The Environments tab renders with no environment chosen — it is where
          the choice is made. Every other tab has nothing to show until then. */}
      {!loading && !error && !switching && (!needsEnvironment || tab === LANDING_TAB) ? (
        <div role="tabpanel" id={TAB_PANEL_ID} aria-labelledby={tabButtonId(tab)}>
          <TabBody
            tab={tab}
            payload={payload}
            environments={environments}
            environmentActions={{
              onSelect: (id) => void selectEnvironment(id),
              busy: switching,
            }}
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
        </div>
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

      {confirmingStack ? (
        <StackConfirmDialog
          stack={confirmingStack.stack}
          action={confirmingStack.action}
          busy={busyStack === confirmingStack.stack.Id}
          onCancel={() => setConfirmingStack(undefined)}
          onConfirm={() => sendStackAction(confirmingStack.stack, confirmingStack.action)}
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
  environments,
  environmentActions,
  actions,
  stackActions,
  onNewStack,
}: {
  tab: TabId;
  payload: TabPayload;
  /** Held by the panel rather than taken from the payload, so switching
      environment does not blank the table the choice was made from. */
  environments: EnvironmentRow[];
  environmentActions: EnvironmentActionsProps;
  actions: ContainerActionsProps;
  stackActions: StackActionsProps;
  onNewStack: () => void;
}): ReactElement {
  switch (tab) {
    case 'environments':
      return <EnvironmentsTable rows={environments} actions={environmentActions} />;
    case 'stacks':
      return (
        <div>
          <div className="d-flex justify-content-end mb-2">
            <GatedButton
              className="btn btn-sm btn-outline-primary"
              label="New stack"
              {...(stackActions.control?.allowPutControl
                ? {}
                : {
                    reason:
                      'stack control is disabled; enable "Allow Signal K PUT control" in the plugin configuration',
                  })}
              onPress={onNewStack}
            />
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
