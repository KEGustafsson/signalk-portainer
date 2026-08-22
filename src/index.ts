import type { IRouter } from 'express';
import { ConfigError, normalizeConfig, PLUGIN_SCHEMA, type RawConfig } from './config';
import { registerRoutes } from './facade';
import { InstanceRegistry } from './registry';
import { redactText } from './redact';
import type { SignalKApp, SignalKPlugin } from './signalk';

const PLUGIN_ID = 'signalk-portainer';

const plugin = (app: SignalKApp): SignalKPlugin => {
  let registry: InstanceRegistry | undefined;

  const log = (message: string): void => app.debug(redactText(message));

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
        const config = normalizeConfig(options as RawConfig | undefined);
        registry = new InstanceRegistry(config.instances, log);
        setStatus(`Starting — ${registry.names.length} instance(s): ${registry.names.join(', ')}`);
        void reportHealth();
      } catch (cause) {
        registry = undefined;
        if (cause instanceof ConfigError) setError(cause.message);
        else setError(`Failed to start: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },

    stop(): void {
      registry?.close();
      registry = undefined;
      setStatus('Stopped');
    },

    registerWithRouter(router: IRouter): void {
      registerRoutes(router, { registry: () => registry, log });
    },
  };
};

export = plugin;
