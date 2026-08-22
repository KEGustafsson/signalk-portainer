import type { IRouter } from 'express';
import {
  ConfigError,
  normalizeConfig,
  PLUGIN_SCHEMA,
  type PluginConfig,
  type RawConfig,
} from './config';
import type { MetaValue, PathValue } from './deltas';
import { registerRoutes } from './facade';
import { DeltaPoller } from './poller';
import { InstanceRegistry } from './registry';
import { redactText } from './redact';
import { detectSelfContainer, type SelfContainer } from './self';
import type { SignalKApp, SignalKPlugin } from './signalk';

const PLUGIN_ID = 'signalk-portainer';

const plugin = (app: SignalKApp): SignalKPlugin => {
  let registry: InstanceRegistry | undefined;
  let config: PluginConfig | undefined;
  let poller: DeltaPoller | undefined;
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

        // 'off' is honoured by never constructing the poller, so a plugin the
        // operator told to stay quiet issues no polls at all.
        if (config.telemetry.level !== 'off') {
          poller = new DeltaPoller({
            registry: () => registry,
            publish,
            log,
            intervalMs: config.telemetry.intervalSeconds * 1000,
            pathPrefix: config.telemetry.pathPrefix,
            level: config.telemetry.level,
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
      });
    },
  };
};

export = plugin;
