import type { IRouter } from 'express';
import {
  ConfigError,
  normalizeConfig,
  PLUGIN_SCHEMA,
  type PluginConfig,
  type RawConfig,
} from './config';
import type { MetaValue, PathValue } from './deltas';
import { ExecTickets } from './exectickets';
import { openConsole, type ConsoleServer } from './console';
import { ConsoleSessions } from './consolesessions';
import { registerRoutes } from './facade';
import { DeltaPoller, type KeyedContainer } from './poller';
import { PutHandlers, replaceKnownContainers, type ActionHandler } from './put';
import { InstanceRegistry } from './registry';
import { redactText } from './redact';
import { detectSelfContainer, type SelfContainer } from './self';
import type { SignalKApp, SignalKPlugin } from './signalk';
import { Watchdog, type Notification } from './watchdog';

const PLUGIN_ID = 'signalk-portainer';

const plugin = (app: SignalKApp): SignalKPlugin => {
  let registry: InstanceRegistry | undefined;
  let config: PluginConfig | undefined;
  let poller: DeltaPoller | undefined;
  /** Containers seen on the last poll, keyed by "<instance>/<key>", for PUT. */
  let seen = new Map<string, KeyedContainer>();
  /**
   * Console authorisations, and the socket endpoint that redeems them. Both
   * absent when the server is too old to let a plugin serve a WebSocket, and
   * the console is then not offered rather than half-offered.
   */
  let tickets: ExecTickets | undefined;
  let sessions: ConsoleSessions | undefined;
  let consoleServer: ConsoleServer | undefined;
  // Detected once at load: the container id cannot change under a running
  // process, and probing /proc on every request would be wasted work.
  const self: SelfContainer = detectSelfContainer();

  const log = (message: string): void => app.debug(redactText(message));

  /**
   * One delta carrying this poll's values and any first-time metadata.
   *
   * Both go in a single message so a dashboard never renders a numeric path for
   * a moment before learning its units.
   */
  const publish = (values: PathValue[], meta: MetaValue[]): void => {
    const updates: Record<string, unknown>[] = [];
    if (values.length > 0) updates.push({ values });
    if (meta.length > 0) updates.push({ meta });
    if (updates.length === 0) return;
    app.handleMessage(PLUGIN_ID, {
      updates,
    } as Parameters<typeof app.handleMessage>[1]);
  };

  /**
   * Notifications go out as ordinary deltas on notifications.* paths, which is
   * how every other Signal K alarm reaches a chartplotter.
   */
  const publishNotifications = (notifications: Notification[]): void => {
    if (notifications.length === 0) return;
    publish(
      notifications.map((entry) => ({ path: entry.path, value: entry.value })),
      [],
    );
  };

  // Redaction happens once, here, so no host callback can ever receive a raw
  // message: setPluginStatus/setPluginError persist their text in the server.
  const setStatus = (message: string): void => {
    const safe = redactText(message);
    app.setPluginStatus(safe);
    app.debug(safe);
  };

  const setError = (message: string): void => {
    const safe = redactText(message);
    app.setPluginError(safe);
    app.error(safe);
  };

  /**
   * Reports reachability without blocking start(): the plugin must come up
   * even when Portainer is down, so the UI can say why.
   */
  const reportHealth = async (): Promise<void> => {
    // stop() can clear the registry, and a restart can replace it, while this
    // probe is in flight; results from a superseded registry must be dropped.
    const active = registry;
    if (!active) return;
    try {
      const health = await active.health();
      if (registry !== active) return;
      const up = health.filter((instance) => instance.reachable);
      if (up.length === health.length) {
        const detail = up
          .map((instance) => {
            const version = instance.portainerVersion ? ` ${instance.portainerVersion}` : '';
            const swarm = instance.capabilities?.swarm ? ', swarm' : '';
            return `${instance.name}${version} (${instance.environment?.name ?? '?'}${swarm})`;
          })
          .join('; ');
        setStatus(`Connected: ${detail}`);
        return;
      }
      const failed = health.filter((instance) => !instance.reachable);
      const detail = failed.map((i) => `${i.name}: ${i.error ?? 'unreachable'}`).join('; ');
      if (up.length === 0) setError(`No Portainer instance reachable — ${detail}`);
      else setError(`${up.length}/${health.length} instances reachable — ${detail}`);
    } catch (cause) {
      if (registry !== active) return;
      setError(`Health check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  return {
    id: PLUGIN_ID,
    name: 'Portainer',
    description: 'Manage Portainer CE containers and stacks, and publish container health',
    schema: PLUGIN_SCHEMA,

    start(options: object, _restart: (newConfiguration: object) => void): void {
      try {
        config = normalizeConfig(options as RawConfig | undefined);
        registry = new InstanceRegistry(config.instances, log);
        if (self.inContainer && !self.identified) {
          log(
            'Running in a container but unable to identify which one — the Signal K container cannot be protected from being stopped',
          );
        } else if (self.identified) {
          log(`Signal K appears to run in container ${self.shortId} (via ${self.source})`);
        }
        setStatus(`Starting — ${registry.names.length} instance(s): ${registry.names.join(', ')}`);
        void reportHealth();

        // Feature-detected rather than assumed: a plugin WebSocket needs a
        // server new enough to offer one, and on an older one the console is
        // absent from /control instead of being a button that cannot work.
        if (config.control.allowPutControl && typeof app.registerWebSocket === 'function') {
          tickets = new ExecTickets();
          sessions = new ConsoleSessions();
          consoleServer = openConsole({
            register: (path) => app.registerWebSocket!(path),
            tickets,
            sessions,
            registry: () => registry,
            log,
          });
        } else if (config.control.allowPutControl) {
          log(
            'This Signal K server cannot serve a plugin WebSocket, so the container console is not available',
          );
        }

        // Only when something is actually watched. Alarms nobody asked for are
        // worse than no alarms: the first thing an operator does with an alarm
        // they did not configure is learn to ignore that channel.
        const watchdog =
          config.control.watchdog.length > 0
            ? new Watchdog(config.telemetry.pathPrefix, config.control.watchdog)
            : undefined;

        // PUT writes to a published path, so there is nothing to register when
        // nothing is published. The REST facade still controls containers.
        const putsWanted = config.control.allowPutControl && config.telemetry.level !== 'off';
        const puts =
          putsWanted && app.registerPutHandler
            ? new PutHandlers(
                {
                  registry: () => registry,
                  config: () => config,
                  self: () => self,
                  log,
                  register: (context, path, handler) =>
                    app.registerPutHandler?.(context, path, handler as ActionHandler),
                },
                (instance, key) => seen.get(`${instance}/${key}`),
              )
            : undefined;

        // 'off' means off: no polling, no paths. The one thing that still needs
        // a poll is a configured watchdog, which cannot check a container
        // without looking at it — it then publishes alarms and nothing else.
        if (config.telemetry.level !== 'off' || watchdog) {
          const prefix = config.telemetry.pathPrefix;
          poller = new DeltaPoller({
            registry: () => registry,
            // A level of 'off' still polls for the watchdog, so the values are
            // built and then dropped rather than sent.
            publish: config.telemetry.level === 'off' ? () => undefined : publish,
            log,
            intervalMs: config.telemetry.intervalSeconds * 1000,
            pathPrefix: prefix,
            level: config.telemetry.level === 'off' ? 'health' : config.telemetry.level,
            watchdog,
            publishNotifications,
            onKeys: (instance, keys, containers) => {
              // Replaced, not merged: a container that has gone must stop
              // resolving, or a PUT to its path reaches Docker and fails as a
              // gateway error instead of saying plainly that it is not there.
              seen = replaceKnownContainers(seen, instance, containers);
              puts?.register(instance, keys, prefix);
            },
          });
          poller.start();
        }
      } catch (cause) {
        poller?.stop();
        poller = undefined;
        registry = undefined;
        config = undefined;
        if (cause instanceof ConfigError) setError(cause.message);
        else setError(`Failed to start: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },

    stop(): void {
      // Before the registry closes: stopping clears the published paths, and
      // that clearing delta has to go out while the plugin still can send it.
      poller?.stop();
      poller = undefined;
      seen = new Map();
      // Every open shell ends with the plugin, and every unredeemed ticket
      // stops being one.
      consoleServer?.close();
      consoleServer = undefined;
      tickets?.clear();
      tickets = undefined;
      sessions?.clear();
      sessions = undefined;
      registry?.close();
      registry = undefined;
      config = undefined;
      setStatus('Stopped');
    },

    registerWithRouter(router: IRouter): void {
      registerRoutes(router, {
        registry: () => registry,
        config: () => config,
        self: () => self,
        log,
        // Read through a getter rather than captured: the router is registered
        // once, and the tickets come and go with each start.
        get execTickets() {
          return tickets;
        },
        get consoleSessions() {
          return sessions;
        },
      });
    },
  };
};

export = plugin;
