import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Capabilities,
  DockerContainer,
  DockerDiskUsage,
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
import { ImageDeleteDialog } from './ImageDeleteDialog';
import { ImagePruneDialog } from './ImagePruneDialog';
import { ImagePullDialog, type RegistryOption } from './ImagePullDialog';
import { PanelBoundary } from './PanelBoundary';
import { LogViewer } from './LogViewer';
import { StackAutoUpdateDialog } from './StackAutoUpdateDialog';
import { StackConfirmDialog, type ConfirmableStackAction } from './StackConfirmDialog';
import { StackDeleteDialog } from './StackDeleteDialog';
import { StackEditor, type StackDeployment, type StackTarget } from './StackEditor';
import { STACK_CONTROL_DISABLED, normalizeStacks, type StackAction } from './stackcontrol';
import {
  actionLabel,
  actionRequest,
  imageActionLabel,
  imageActionState,
  imagePullState,
  imageRequest,
  needsConfirmation,
  normalizeControl,
  type ContainerAction,
  type ControlState,
  type RemoveOptions,
} from './control';
import { containerName, formatBytes, imageUsers, reclaimableImageBytes, shortId } from './format';
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
  type ImageActionsProps,
  type StackActionsProps,
} from './tables';

const POLL_INTERVAL_MS = 10_000;

/**
 * How far the poll backs off while reads are failing, and the ceiling it
 * stops at.
 *
 * A Portainer that is down is down for minutes, not milliseconds, and every
 * open admin tab was asking it again every ten seconds — on a boat's server,
 * with a shore instance over a metered link, for as long as the tab stayed
 * open.
 */
const POLL_BACKOFF_CEILING_MS = 60_000;

/**
 * What `busyId` holds while a prune is in flight.
 *
 * A prune has no row to be busy on, and every other id in that slot is a
 * container or an image id — hex, or `sha256:` and hex. Nothing Docker names
 * can collide with this.
 */
const PRUNE_BUSY_KEY = 'images:prune';
const PULL_BUSY_KEY = 'images:pull';
const AUTO_UPDATE_BUSY_KEY = 'stacks:autoupdate';

interface InstanceSummary {
  name: string;
  isDefault: boolean;
  /**
   * Where this Portainer answers, as the plugin is configured to reach it.
   * Reported by `/instances` already; read here so a webhook URL can be shown
   * in full rather than as an id the operator has to assemble a URL from.
   */
  baseUrl?: string;
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
  /**
   * Only from /environments: why there is no selection when the operator
   * made one. A saved id that Portainer no longer has is the usual reason.
   */
  warning?: string;
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
  /**
   * What the server said about a choice it could not honour: a saved
   * environment id that no longer exists, or a selection it could not
   * persist. Kept apart from the errors because neither stops the panel
   * working — they only say that something will not be as the operator
   * expects.
   */
  const [environmentWarning, setEnvironmentWarning] = useState<string | undefined>(undefined);
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
  /**
   * The stack whose auto-update is being edited, and how the last save went.
   * Kept in the dialog rather than the page banner: the settings that produced
   * a refusal are still on screen beside it.
   */
  const [autoUpdating, setAutoUpdating] = useState<Stack | undefined>(undefined);
  const [autoUpdateResult, setAutoUpdateResult] = useState<
    { ok: true; message: string } | { ok: false; error: ApiError } | undefined
  >(undefined);
  // Kept apart from the poll's error for the same reason a container action is.
  const [stackResult, setStackResult] = useState<
    { ok: true; message: string } | { ok: false; error: ApiError } | undefined
  >(undefined);
  /**
   * Every id a request is currently in flight for.
   *
   * A set rather than one id: two actions can be in flight at once — start
   * one container, then another — and a single slot meant the first to
   * finish re-enabled the second's buttons while its request was still open,
   * so a second press re-sent it. Restart and Kill are not idempotent.
   */
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const startBusy = useCallback((id: string) => {
    setBusyIds((current) => new Set(current).add(id));
  }, []);
  const endBusy = useCallback((id: string) => {
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);
  // Docker's account of what the images cost, read only while the Images tab
  // is open. The image that is about to be deleted, and whether a prune is
  // being confirmed, live beside it.
  const [usage, setUsage] = useState<DockerDiskUsage | undefined>(undefined);
  const [deletingImage, setDeletingImage] = useState<DockerImage | undefined>(undefined);
  const [pruning, setPruning] = useState(false);
  /**
   * The pull dialog, and the registries it offers.
   *
   * Read when the dialog opens rather than on the poll: registries change
   * when an operator adds one, which is not something worth a request every
   * ten seconds on a boat's link. A failure is carried rather than thrown —
   * an anonymous pull still works without the list.
   */
  const [pulling, setPulling] = useState(false);
  const [registries, setRegistries] = useState<RegistryOption[]>([]);
  const [registriesError, setRegistriesError] = useState<string | undefined>(undefined);
  const [pullResult, setPullResult] = useState<
    { ok: true; message: string } | { ok: false; error: ApiError } | undefined
  >(undefined);
  // Kept apart from `error`: the poll clears that one on its next success, and
  // a refused action is exactly what the operator still needs to read.
  const [actionResult, setActionResult] = useState<
    { ok: true; message: string } | { ok: false; error: ApiError } | undefined
  >(undefined);

  // Keeps a slow response from overwriting the results of a later request when
  // the operator switches tab or instance while one is still in flight.
  const requestSeq = useRef(0);
  // The same guard for /df, which needs its own: a prune reads it while the
  // read the tab started may still be open, and that one predates the prune.
  const usageSeq = useRef(0);
  // And its own again for /registries, which the instance guard cannot cover:
  // an environment switch leaves the panel on the same Portainer, so a read
  // started before the switch passes that guard while answering for the
  // environment the operator has just left.
  const registrySeq = useRef(0);
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

  /**
   * Whether the panel is still on the Portainer a request was sent to.
   *
   * Everything a completion writes describes the instance the request went
   * to: a result banner, the dialog it closes, the busy mark it lifts. Written
   * after the operator has switched, it describes a Portainer they are no
   * longer looking at — and worse, it can clear state belonging to something
   * they have since started on the new one, re-enabling a button whose
   * request is still open.
   */
  const stillOn = useCallback((startedOn: string | undefined): boolean => {
    return selected.current === startedOn;
  }, []);

  const activeTab = useMemo(
    () => TABS.find((candidate) => candidate.id === tab) ?? TABS[0]!,
    [tab],
  );

  /**
   * The tab on screen, readable from inside a `load` that was created for a
   * different one.
   *
   * An action's refresh runs the `load` of the render it was started from,
   * which is bound to the tab that was open then. After a switch that read
   * the old tab's path, aborted the new tab's request and painted its answer
   * under the new tab's heading — "No containers" for a table that had
   * plenty.
   */
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  });

  /**
   * Several environments, none chosen. Distinct from "still loading": the
   * panel has an answer, and the answer is that the operator has to pick.
   */
  const needsEnvironment = environment === null && environments.length > 1;

  /** The environment in use, once there is one and its row has been read. */
  const chosen = environments.find((entry) => entry.id === environment);

  /** Where the selected Portainer answers, for the webhook URL to be shown. */
  const instanceBaseUrl = useMemo(
    () => instances.find((entry) => entry.name === instance)?.baseUrl,
    [instance, instances],
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
      const body = await apiGet<{
        environments: EnvironmentRow[];
        selected: number | null;
        warning?: string;
      }>('/environments', instance, signal);
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
      setEnvironmentWarning(typeof body.warning === 'string' ? body.warning : undefined);
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

  /**
   * What the server currently allows, re-read on every tick.
   *
   * Read once per instance, an open panel never learned that control had
   * been enabled in the plugin configuration: every button stayed inert
   * until the page was reloaded. This is a read of the plugin's own parsed
   * configuration, with no Portainer call behind it.
   */
  const loadControl = useCallback(async (): Promise<void> => {
    const startedOn = instance;
    try {
      const answer = normalizeControl(await apiGet<unknown>('/control', instance));
      // What one Portainer allows says nothing about the next: an answer that
      // lands after a switch would gate the new instance's buttons by the old
      // instance's rules until the next tick corrected it.
      if (stillOn(startedOn)) setControl(answer);
    } catch {
      // Without an answer the panel offers nothing rather than guessing: the
      // buttons stay disabled and say they are waiting on the plugin.
      if (stillOn(startedOn)) setControl(undefined);
    }
  }, [instance, stillOn]);

  const load = useCallback(async (): Promise<boolean> => {
    // The tab as it is now, not as it was when this callback was created.
    const target = activeTabRef.current;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const seq = (requestSeq.current += 1);
    try {
      const body = await apiGet<TabPayload>(target.path, instance, controller.signal);
      if (seq !== requestSeq.current) return true;
      setPayload(body);
      // This tab reads the very list the choice is made from, so one read keeps
      // both current: an environment that goes down, or a choice made from
      // another browser, shows up without a second request.
      if (target.id === 'environments') {
        setEnvironments(rowsOf(body.environments));
        setEnvironment(body.selected ?? null);
        setEnvironmentWarning(typeof body.warning === 'string' ? body.warning : undefined);
      }
      setError(undefined);
      return true;
    } catch (cause) {
      // A cancelled request is expected, not a failure to report.
      if (isAbort(cause) || seq !== requestSeq.current) return true;
      setError(asApiError(cause));
      return false;
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        inFlight.current = undefined;
      }
    }
  }, [instance]);

  /**
   * Docker's own figures for the images: what the layers cost, and which of
   * them a container is holding.
   *
   * Read on its own rather than with the tab payload, and deliberately not on
   * the ten-second poll: /system/df walks the layer store, which on the SD
   * card of a Raspberry Pi is seconds of work every time. Once when the tab is
   * opened and again after a prune are the two moments the number is being
   * read, so they are the two times it is asked for.
   */
  const loadUsage = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const seq = (usageSeq.current += 1);
      try {
        const body = await apiGet<{ df?: DockerDiskUsage }>('/df', instance, signal);
        // A read this one overtook is a read of the state before: the tab's
        // opening /df can land after the prune's, and letting it through puts
        // the pre-prune total and its badges back over what the prune freed.
        if (seq !== usageSeq.current) return;
        setUsage(body.df);
      } catch {
        // Deliberately silent. Nothing is offered on the strength of this read
        // — without it the summary says so and the rows carry no badge — and
        // the tab's own read is what reports a Portainer that is really down.
      }
    },
    [instance],
  );

  useEffect(() => {
    if (tab !== 'images' || instances.length === 0) return;
    // Same gate the tab read is under: /system/df goes through the environment,
    // so it has nothing to answer while the choice is still open.
    if (environment === undefined || needsEnvironment) return;
    const controller = new AbortController();
    // Cleared first: a figure from the instance or environment just left would
    // otherwise sit under the new one's rows until this read lands.
    setUsage(undefined);
    void loadUsage(controller.signal);
    return () => {
      controller.abort();
      // The abort only reaches this read. A prune's /df carries no signal, so
      // retiring the sequence is what stops one that is still open from
      // answering for the instance or tab the operator has just left.
      usageSeq.current += 1;
    };
  }, [tab, instances.length, environment, needsEnvironment, loadUsage]);

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
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_INTERVAL_MS;

    /**
     * One tick, and the next one scheduled from what this one cost.
     *
     * A fixed interval that aborted its own predecessor could never report a
     * backend that had stopped answering: every read was cancelled by the
     * next before its own deadline could fire, so the panel sat under
     * "Loading…" with no error, asking again forever. A tick that finds a
     * read still in flight now leaves it alone and lets the deadline in
     * `api.ts` turn it into a real failure — and a failure slows the next
     * one down instead of hammering a Portainer that is down.
     */
    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (document.hidden || inFlight.current) {
        schedule(delay);
        return;
      }
      // The control read rides along with the poll: it is a read of the
      // plugin's own configuration, so it costs nothing upstream.
      void loadControl();
      const ok = await load();
      delay = ok
        ? POLL_INTERVAL_MS
        : Math.min(POLL_BACKOFF_CEILING_MS, Math.max(POLL_INTERVAL_MS, delay * 2));
      schedule(delay);
    };

    function schedule(after: number): void {
      if (stopped) return;
      // Whatever was pending is dropped first. A tab becoming visible while a
      // read was in flight scheduled one tick, and the read finishing
      // scheduled another; only the second was ever cancellable, so each such
      // switch left another chain polling and the backoff counted for nothing.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void tick();
      }, after);
    }

    void (async () => {
      // The first read of both, before any tick: what the server allows is
      // what decides whether a row's buttons are offered at all, and waiting
      // a whole interval for it left every button inert on arrival.
      void loadControl();
      await load();
      schedule(delay);
    })();

    // A hidden tab stops asking, and asks once the moment it is looked at
    // again rather than waiting out the delay it stopped on.
    const onVisible = (): void => {
      if (stopped || document.hidden) return;
      if (timer) clearTimeout(timer);
      delay = POLL_INTERVAL_MS;
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      // Unmounting or switching away must not leave a request open.
      inFlight.current?.abort();
    };
  }, [load, loadControl, instances.length, environment, needsEnvironment, tab]);

  const runAction = useCallback(
    async (
      container: DockerContainer,
      action: ContainerAction,
      options: RemoveOptions,
    ): Promise<void> => {
      startBusy(container.Id);
      setActionResult(undefined);
      const startedOn = instance;
      const { method, path } = actionRequest(container.Id, action, options);
      try {
        await apiSend(method, path, startedOn);
        // Nothing is written for a Portainer the operator has left: the views
        // this would touch were closed by the switch, and `load` is bound to
        // the old instance — running it now would abort the new instance's
        // request and paint its table with the old one's containers.
        if (!stillOn(startedOn)) return;
        // Only this container's dialog. Cleared unconditionally, a slow stop
        // on one container closed the confirmation the operator had just
        // opened for another, and nothing stopped that one.
        setConfirming((open) => (open?.container.Id === container.Id ? undefined : open));
        setActionResult({
          ok: true,
          message: `${actionLabel(action)} ${containerName(container.Names)}: done`,
        });
        // Straight to a fresh read: the table is the confirmation that it
        // worked, and the 10s poll is too slow to feel like one.
        await load();
      } catch (cause) {
        if (!stillOn(startedOn)) return;
        setConfirming((open) => (open?.container.Id === container.Id ? undefined : open));
        const failure = asApiError(cause);
        setActionResult({ ok: false, error: failure });
        // A refusal means the rules changed under the panel — control turned
        // off, or the allowlist narrowed — so what it may offer is re-read
        // rather than left showing buttons that no longer work.
        if (failure.status === 403) void loadControl();
      } finally {
        // The switch cleared the whole set; lifting one id now would only
        // reach an operation the operator has since started.
        if (stillOn(startedOn)) endBusy(container.Id);
      }
    },
    [endBusy, instance, load, loadControl, startBusy, stillOn],
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

  /**
   * Runs an image mutation, then re-reads the list and the disk usage.
   *
   * Guarded on the instance for the reason a container action is: an answer
   * that arrives after the operator has switched Portainer belongs to the one
   * they left, and running `load` for it would abort the new instance's
   * request and paint its table with the old one's rows.
   *
   * Such an answer reports `ok: false`, which is what the callers need: the
   * dialog each of them would close on success was closed by the switch, and
   * closing it now would close whatever has been opened since.
   */
  const runImage = useCallback(
    async (busyKey: string, run: () => Promise<unknown>, done: (body: unknown) => string) => {
      startBusy(busyKey);
      setActionResult(undefined);
      const startedOn = instance;
      try {
        const body = await run();
        if (!stillOn(startedOn)) return { ok: false };
        setActionResult({ ok: true, message: done(body) });
        await load();
        // After the list, not with it: the summary is the answer to what the
        // prune just did, and reading it first would report the state before.
        await loadUsage();
        return { ok: true };
      } catch (cause) {
        if (!stillOn(startedOn)) return { ok: false };
        const failure = asApiError(cause);
        setActionResult({ ok: false, error: failure });
        if (failure.status === 403) void loadControl();
        return { ok: false };
      } finally {
        if (stillOn(startedOn)) endBusy(busyKey);
      }
    },
    [endBusy, instance, load, loadControl, loadUsage, startBusy, stillOn],
  );

  const removeImage = useCallback(
    (image: DockerImage): void => {
      const label = image.RepoTags?.[0] ?? shortId(image.Id);
      // By id rather than by tag: an id names exactly the layers on the row
      // that was pressed, where a tag is a pointer that another tag may share.
      // Docker refuses an id carrying several tags, which the dialog says.
      const { method, path } = imageRequest('remove', image.Id);
      void runImage(
        image.Id,
        () => apiSend(method, path, instance),
        () => `${label}: deleted`,
      ).then((outcome) => {
        if (outcome.ok) setDeletingImage(undefined);
      });
    },
    [instance, runImage],
  );

  /**
   * Opens the pull dialog and reads the registries it offers.
   *
   * The list is not required: an anonymous pull is the common case and works
   * without it, so a failure to read it is shown inside the dialog rather
   * than stopping it from opening.
   */
  const startPull = useCallback((): void => {
    setPullResult(undefined);
    setRegistriesError(undefined);
    // Cleared before the read rather than left standing: the list the dialog
    // was last opened with belongs to whichever environment offered it, and
    // showing it here would offer ids that name something else — or nothing.
    setRegistries([]);
    setPulling(true);
    const startedOn = instance;
    const seq = (registrySeq.current += 1);
    void apiGet<{ registries?: unknown }>('/registries', instance)
      .then((body) => {
        if (!stillOn(startedOn) || seq !== registrySeq.current) return;
        setRegistries(registryOptions(body.registries));
      })
      .catch((cause: unknown) => {
        if (!stillOn(startedOn) || seq !== registrySeq.current) return;
        setRegistries([]);
        setRegistriesError(asApiError(cause).message);
      });
  }, [instance, stillOn]);

  /**
   * Fetches an image, optionally through one of Portainer's registries.
   *
   * The dialog stays open on either outcome: a success names what Docker
   * reported and the operator may want another, and a failure — a tag that
   * does not exist, a registry that refused — is worth reading beside the box
   * that produced it.
   */
  const pullImage = useCallback(
    (request: { reference: string; registryId?: number }): void => {
      const startedOn = instance;
      startBusy(PULL_BUSY_KEY);
      setPullResult(undefined);
      void (async () => {
        try {
          const body = await apiSend<{ status?: unknown }>(
            'POST',
            '/images/pull',
            startedOn,
            undefined,
            request,
          );
          if (!stillOn(startedOn)) return;
          const status = typeof body?.status === 'string' ? body.status : '';
          setPullResult({
            ok: true,
            message: status ? `${request.reference}: ${status}` : `${request.reference}: fetched`,
          });
          await load();
          await loadUsage();
        } catch (cause) {
          if (!stillOn(startedOn)) return;
          const failure = asApiError(cause);
          setPullResult({ ok: false, error: failure });
          if (failure.status === 403) void loadControl();
        } finally {
          if (stillOn(startedOn)) endBusy(PULL_BUSY_KEY);
        }
      })();
    },
    [endBusy, instance, load, loadControl, loadUsage, startBusy, stillOn],
  );

  const pruneImages = useCallback(
    (options: { all: boolean }): void => {
      const { method, path } = imageRequest('prune', options);
      void runImage(
        PRUNE_BUSY_KEY,
        () => apiSend(method, path, instance),
        (body) => {
          const result = (body ?? {}) as { deleted?: number; reclaimed?: number };
          const deleted = typeof result.deleted === 'number' ? result.deleted : 0;
          // Docker's own figure for what it freed, not the panel's estimate of
          // what it might: those two disagreeing is worth seeing.
          const freed = typeof result.reclaimed === 'number' ? formatBytes(result.reclaimed) : '—';
          return deleted === 0
            ? 'Nothing to reclaim: no unused images were found'
            : `${deleted} image${deleted === 1 ? '' : 's'} removed, ${freed} freed`;
        },
      ).then((outcome) => {
        if (outcome.ok) setPruning(false);
      });
    },
    [instance, runImage],
  );

  const runStack = useCallback(
    async (stack: Stack, run: () => Promise<unknown>, done: string): Promise<{ ok: boolean }> => {
      setBusyStack(stack.Id);
      setStackResult(undefined);
      const startedOn = instance;
      try {
        const body = (await run()) as { warning?: unknown } | undefined;
        if (!stillOn(startedOn)) return { ok: false };
        // Portainer clears a stack's auto-update on every update, and ignores
        // prune on a compose stack before 2.42. The facade says so in the
        // answer; dropping it left the operator to discover it when the
        // webhook stopped firing.
        const warning = typeof body?.warning === 'string' ? body.warning : undefined;
        setStackResult({
          ok: true,
          message: `${stack.Name}: ${done}${warning ? `. ${warning}` : ''}`,
        });
        // Straight to a fresh read, as a container action does — the table is
        // the confirmation, and the 10s poll is too slow to feel like one.
        await load();
        return { ok: true };
      } catch (cause) {
        if (!stillOn(startedOn)) return { ok: false };
        setStackResult({ ok: false, error: asApiError(cause) });
        return { ok: false };
      } finally {
        // One id, not a set: clearing it for a stack on the Portainer the
        // operator has left would re-enable the buttons of whatever they have
        // started on this one.
        if (stillOn(startedOn)) setBusyStack(undefined);
      }
    },
    [instance, load, stillOn],
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
      ).then((outcome) => {
        if (outcome.ok) setConfirmingStack(undefined);
      });
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
      if (action === 'autoupdate') {
        setAutoUpdateResult(undefined);
        setAutoUpdating(stack);
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

  /**
   * Saves a stack's auto-update, and re-reads the stacks so the row shows it.
   *
   * The dialog stays open on either outcome. A success is worth reading — it
   * is where a newly created webhook URL first appears — and a failure leaves
   * the settings that caused it on screen to be corrected.
   */
  const saveAutoUpdate = useCallback(
    (settings: { interval?: string; webhook?: boolean; pullImage?: boolean; force?: boolean }) => {
      const target = autoUpdating;
      if (!target) return;
      const startedOn = instance;
      startBusy(AUTO_UPDATE_BUSY_KEY);
      setAutoUpdateResult(undefined);
      void (async () => {
        try {
          await apiSend('PUT', `/stacks/${target.Id}/autoupdate`, startedOn, undefined, settings);
          if (!stillOn(startedOn)) return;
          const on = settings.interval !== undefined || settings.webhook === true;
          setAutoUpdateResult({
            ok: true,
            message: on
              ? `${target.Name}: auto-update saved`
              : `${target.Name}: auto-update turned off`,
          });
          // The dialog reads the stack it was given, so the fresh record is
          // what puts a just-created webhook URL on screen.
          await load();
        } catch (cause) {
          if (!stillOn(startedOn)) return;
          const failure = asApiError(cause);
          setAutoUpdateResult({ ok: false, error: failure });
          if (failure.status === 403) void loadControl();
        } finally {
          if (stillOn(startedOn)) endBusy(AUTO_UPDATE_BUSY_KEY);
        }
      })();
    },
    [autoUpdating, endBusy, instance, load, loadControl, startBusy, stillOn],
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
    // A stack id, and a webhook URL that names this Portainer: neither means
    // anything on the next one.
    setAutoUpdating(undefined);
    setAutoUpdateResult(undefined);
    // An image id belongs to its Docker host as much as a container id does,
    // and the prune dialog quotes a figure that is about to stop being true.
    setDeletingImage(undefined);
    setPruning(false);
    // The registries belong to the environment that offered them, and an id
    // from one Portainer names something else on the next.
    setPulling(false);
    setRegistries([]);
    setRegistriesError(undefined);
    setPullResult(undefined);
    // Clearing the list is not enough on an environment switch: the panel is
    // still on the same Portainer, so a /registries read already in flight
    // would pass its instance guard and put the old environment's list back.
    registrySeq.current += 1;
    setUsage(undefined);
    // These hold a container id too, and a result about a Portainer the
    // operator has left says nothing about the one they are looking at.
    setConfirming(undefined);
    setActionResult(undefined);
    setEnvironmentWarning(undefined);
    // A busy mark names a container or a stack on the instance being left, and
    // the request that set it will not clear it once it is no longer current.
    setBusyIds(new Set());
    setBusyStack(undefined);
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
        const answer = await apiSend<{ selected: number; persisted?: boolean; warning?: string }>(
          'PUT',
          '/environment',
          instance,
          undefined,
          { id },
        );
        // Guarded the same way an action's refresh is: if the operator has
        // switched Portainer while the PUT was in flight, this answer belongs
        // to the one they left — and an environment id from one Portainer
        // names nothing on the next.
        if (!stillOn(startedOn)) return;
        setEnvironment(id);
        await loadEnvironments(undefined, () => stillOn(startedOn));
        // After the re-read, which carries no warning of its own and would
        // otherwise clear this one. Live either way; only its survival across
        // a restart is at stake, and an operator who is not told assumes it
        // was saved.
        if (typeof answer?.warning === 'string') setEnvironmentWarning(answer.warning);
      } catch (cause) {
        // Into the setup sink, never into `error`: the next poll succeeds
        // against the environment that was never left, and would clear a
        // refusal the operator has to see.
        if (stillOn(startedOn)) setSetupError(asApiError(cause));
      } finally {
        // Not for a switch the operator has moved on from: this flag locks the
        // picker, and clearing it would unlock it under a switch still running.
        if (stillOn(startedOn)) setSwitching(false);
      }
    },
    [closeInstanceViews, instance, loadEnvironments, stillOn],
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

      {error && error.message !== setupError?.message ? (
        // Not when the dismissible banner below already says the same thing:
        // a failing environment read reports itself twice, once through the
        // read the picker makes and once through the poll behind it.
        <div className="alert alert-danger" role="alert">
          <div>{error.message}</div>
          {error.hint ? <div className="small mt-1">{error.hint}</div> : null}
          <Detail detail={error.detail} />
        </div>
      ) : null}

      {environmentWarning ? (
        <div
          className="alert alert-warning d-flex justify-content-between align-items-start"
          role="alert"
        >
          <div>{environmentWarning}</div>
          <button
            type="button"
            className="btn-close"
            aria-label="Dismiss"
            onClick={() => setEnvironmentWarning(undefined)}
          />
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
            <Detail detail={setupError.detail} />
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
            {actionResult.ok ? null : <Detail detail={actionResult.error.detail} />}
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
            {stackResult.ok ? null : <Detail detail={stackResult.error.detail} />}
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
          the choice is made. Every other tab has nothing to show until then.
          It renders under a failed read too, and that is the point: a saved
          environment Portainer no longer has fails every read, and hiding the
          table hid the only row that could put it right. */}
      {!loading &&
      !switching &&
      (!error || tab === LANDING_TAB) &&
      (!needsEnvironment || tab === LANDING_TAB) ? (
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
              busyIds,
              onAction: requestAction,
              onLogs: setViewing,
              // Absent entirely, rather than disabled, on a server that cannot
              // serve a console at all: there is nothing an operator could do
              // about it, so a permanently dead button is only clutter.
              ...(control?.console.available ? { onConsole: setShelling } : {}),
            }}
            stackActions={{ control, busyId: busyStack, onAction: requestStackAction }}
            imageActions={{
              control,
              busyIds,
              onRemove: (image) => {
                setActionResult(undefined);
                setDeletingImage(image);
              },
              usage,
            }}
            onPrune={() => {
              setActionResult(undefined);
              setPruning(true);
            }}
            onPull={startPull}
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

      {autoUpdating ? (
        <StackAutoUpdateDialog
          // The row from the latest read, so a webhook this dialog just
          // created is the one it shows rather than the absence it opened on.
          stack={normalizeStacks(payload).find((row) => row.Id === autoUpdating.Id) ?? autoUpdating}
          {...(instanceBaseUrl === undefined ? {} : { baseUrl: instanceBaseUrl })}
          busy={busyIds.has(AUTO_UPDATE_BUSY_KEY)}
          {...(autoUpdateResult === undefined ? {} : { result: autoUpdateResult })}
          onCancel={() => setAutoUpdating(undefined)}
          onConfirm={saveAutoUpdate}
        />
      ) : null}

      {deletingImage ? (
        <ImageDeleteDialog
          image={deletingImage}
          users={imageUsers(usage, deletingImage.Id)}
          busy={busyIds.has(deletingImage.Id)}
          onCancel={() => setDeletingImage(undefined)}
          onConfirm={() => removeImage(deletingImage)}
        />
      ) : null}

      {pulling ? (
        <ImagePullDialog
          registries={registries}
          {...(registriesError === undefined ? {} : { registriesError })}
          busy={busyIds.has(PULL_BUSY_KEY)}
          {...(pullResult === undefined ? {} : { result: pullResult })}
          onCancel={() => setPulling(false)}
          onConfirm={pullImage}
        />
      ) : null}

      {pruning ? (
        <ImagePruneDialog
          reclaimable={reclaimableImageBytes(usage)}
          busy={busyIds.has(PRUNE_BUSY_KEY)}
          onCancel={() => setPruning(false)}
          onConfirm={pruneImages}
        />
      ) : null}

      {confirming ? (
        <ConfirmDialog
          request={confirming}
          busy={busyIds.has(confirming.container.Id)}
          onCancel={() => setConfirming(undefined)}
          onConfirm={(options) => void runAction(confirming.container, confirming.action, options)}
        />
      ) : null}
    </div>
  );
}

/**
 * What Portainer itself said about a failure, when it said anything.
 *
 * The plugin's paraphrase names the request; this names the field Portainer
 * objected to, which is the difference between "the update failed with 400"
 * and "yaml: line 5: did not find expected key".
 */
function Detail({ detail }: { detail?: string }): ReactElement | null {
  if (!detail) return null;
  return (
    <div className="small mt-1 font-monospace text-break" data-testid="portainer-detail">
      {detail}
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
  imageActions,
  onPrune,
  onPull,
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
  imageActions: ImageActionsProps;
  onPrune: () => void;
  onPull: () => void;
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
              {...(stackActions.control?.allowPutControl ? {} : { reason: STACK_CONTROL_DISABLED })}
              onPress={onNewStack}
            />
          </div>
          {/* Normalized rather than trusted: these rows carry the ids that
              destructive actions are sent with. */}
          <StacksTable rows={normalizeStacks(payload)} actions={stackActions} />
        </div>
      );
    case 'images':
      return (
        <ImagesTab
          rows={rowsOf(payload.images)}
          actions={imageActions}
          onPrune={onPrune}
          onPull={onPull}
        />
      );
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
 * The images, with what they cost above them.
 *
 * The summary is the reason this tab is worth a header at all: an operator
 * opens it because something is filling the disk, and the per-row sizes do not
 * add up to an answer — layers shared between images are counted in both. The
 * two figures beside the count come from Docker's own accounting, and are
 * absent rather than estimated when that read has not landed.
 */
function ImagesTab({
  rows,
  actions,
  onPrune,
  onPull,
}: {
  rows: DockerImage[];
  actions: ImageActionsProps;
  onPrune: () => void;
  onPull: () => void;
}): ReactElement {
  const total = actions.usage?.LayersSize;
  const reclaimable = reclaimableImageBytes(actions.usage);
  const gate = imageActionState(actions.control);
  // Fetching is gated on control alone, where deleting and pruning also need
  // destructive: a pull takes nothing away.
  const pull = imagePullState(actions.control);

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-2">
        <span className="small text-muted">
          {rows.length} image{rows.length === 1 ? '' : 's'}
          {typeof total === 'number' ? ` · ${formatBytes(total)} on disk` : ''}
          {reclaimable === undefined ? '' : ` · ${formatBytes(reclaimable)} reclaimable`}
        </span>
        <div className="d-flex gap-2">
          <GatedButton
            className="btn btn-sm btn-outline-primary"
            label="Fetch image"
            {...(pull.enabled ? {} : { reason: pull.reason })}
            onPress={onPull}
          />
          <GatedButton
            className="btn btn-sm btn-outline-danger"
            label={imageActionLabel('prune')}
            {...(gate.enabled ? {} : { reason: gate.reason })}
            onPress={onPrune}
          />
        </div>
      </div>
      <ImagesTable rows={rows} actions={actions} />
    </div>
  );
}

/**
 * The registries the facade offered, made safe to render.
 *
 * `apiGet` casts whatever came back. A registry with no numeric id could not
 * be pulled through anyway, and a body that is not a list would throw from
 * `.map` during render — inside someone else's admin UI, which takes their
 * tree down and not just this panel.
 */
function registryOptions(value: unknown): RegistryOption[] {
  if (!Array.isArray(value)) return [];
  const rows: RegistryOption[] = [];
  for (const entry of value as Partial<RegistryOption>[]) {
    if (typeof entry?.id !== 'number') continue;
    rows.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : `Registry ${entry.id}`,
      ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
      authenticated: entry.authenticated === true,
    });
  }
  return rows;
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
