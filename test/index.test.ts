import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import plugin from '../src/index';
import type { SignalKApp } from '../src/signalk';
import * as fixtures from './fixtures';
import { createMockAgent } from './support';

const createApp = (opts: { saveFails?: boolean; canSave?: boolean } = {}) => {
  const statuses: string[] = [];
  const errors: string[] = [];
  const debug: string[] = [];
  const deltas: unknown[] = [];
  const puts: { context: string; path: string; handler: unknown }[] = [];
  const sockets: { path: string; close: () => void }[] = [];
  /** Every options object the plugin asked the server to persist. */
  const saved: object[] = [];
  const debugFn = Object.assign((message: unknown) => debug.push(String(message)), {
    enabled: true,
  });
  const app = {
    debug: debugFn,
    error: (message: string) => errors.push(message),
    setPluginStatus: (message: string) => statuses.push(message),
    setPluginError: (message: string) => errors.push(message),
    handleMessage: (_id: string, message: unknown) => {
      deltas.push(message);
    },
    registerPutHandler: (context: string, path: string, handler: unknown) => {
      puts.push({ context, path, handler });
    },
    ...(opts.canSave === false
      ? {}
      : {
          savePluginOptions: (
            configuration: object,
            cb: (err: NodeJS.ErrnoException | null) => void,
          ) => {
            if (opts.saveFails) {
              cb(new Error('read-only') as NodeJS.ErrnoException);
              return;
            }
            saved.push(JSON.parse(JSON.stringify(configuration)) as object);
            cb(null);
          },
        }),
    registerWebSocket: (path: string) => {
      const endpoint = {
        on: () => endpoint,
        clients: new Set(),
        close: () => undefined,
      };
      sockets.push({ path, close: endpoint.close });
      return endpoint as unknown as ReturnType<NonNullable<SignalKApp['registerWebSocket']>>;
    },
  } as SignalKApp;
  return { app, statuses, errors, debug, deltas, puts, sockets, saved };
};

const noopRestart = (): void => {};

const validOptions = {
  instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }],
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('plugin lifecycle', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('exposes the Signal K plugin contract', () => {
    const { app } = createApp();
    const instance = plugin(app);

    expect(instance.id).toBe('signalk-portainer');
    expect(instance.name).toBe('Portainer');
    expect(typeof instance.start).toBe('function');
    expect(typeof instance.stop).toBe('function');
    expect(typeof instance.registerWithRouter).toBe('function');
  });

  it('keeps the environment out of the configuration form', () => {
    // It is chosen by pressing a row on the panel's Environments tab, and the
    // plugin writes it back itself. An id typed in here by hand is how an
    // operator ends up managing the wrong Docker host.
    const { app } = createApp();
    const instance = plugin(app);

    const ui = instance.uiSchema as {
      instances: { items: Record<string, { 'ui:widget'?: string }> };
    };
    expect(ui.instances.items.environmentId?.['ui:widget']).toBe('hidden');
    expect(ui.instances.items.environmentName?.['ui:widget']).toBe('hidden');
  });

  it('reports a configuration problem as a plugin error rather than throwing', () => {
    const { app, errors } = createApp();
    const instance = plugin(app);

    expect(() => instance.start({ instances: [] }, noopRestart)).not.toThrow();
    expect(errors.join(' ')).toMatch(/No Portainer instance configured/);
  });

  it('starts, reports the connected version, and stops cleanly', async () => {
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo);
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);

    const { app, statuses } = createApp();
    const instance = plugin(app);

    instance.start(validOptions, noopRestart);
    await flush();
    await flush();

    expect(statuses.some((s) => s.includes('2.21.4'))).toBe(true);
    expect(statuses.some((s) => s.includes('local'))).toBe(true);

    instance.stop();
    expect(statuses.at(-1)).toBe('Stopped');
  });

  it('publishes container deltas once started', async () => {
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .persist();
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo)
      .persist();
    pool
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, fixtures.systemStatus)
      .persist();
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, fixtures.containers)
      .persist();

    const { app, deltas } = createApp();
    const instance = plugin(app);

    instance.start({ ...validOptions, telemetry: { level: 'full' } }, noopRestart);
    await flush();
    await flush();
    await flush();

    const paths = deltas.flatMap((delta) =>
      ((delta as { updates?: { values?: { path: string }[] }[] }).updates ?? []).flatMap(
        (update) => update.values ?? [],
      ),
    );
    expect(paths.map((entry) => entry.path)).toContain('system.docker.boat.status.reachable');
    expect(paths.some((entry) => entry.path.includes('.containers.'))).toBe(true);

    instance.stop();
  });

  it('raises a Signal K alarm when a watched container is not running', async () => {
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .persist();
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo)
      .persist();
    pool
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, fixtures.systemStatus)
      .persist();
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, [{ ...fixtures.containers[1], State: 'exited' }])
      .persist();

    const { app, deltas } = createApp();
    const instance = plugin(app);

    instance.start(
      {
        ...validOptions,
        control: { watchdog: [{ instance: 'boat', container: 'ais-logger' }] },
      },
      noopRestart,
    );
    await flush();
    await flush();
    await flush();

    const values = deltas.flatMap((delta) =>
      (
        (delta as { updates?: { values?: { path: string; value: unknown }[] }[] }).updates ?? []
      ).flatMap((update) => update.values ?? []),
    );
    const alarm = values.find(
      (entry) => entry.path === 'notifications.system.docker.boat.containers.ais_logger',
    );
    expect(alarm?.value).toMatchObject({ state: 'alarm' });
    // The instance itself is reachable, so that notification stays normal.
    const status = values.find((entry) => entry.path === 'notifications.system.docker.boat.status');
    expect(status?.value).toMatchObject({ state: 'normal' });

    instance.stop();
  });

  it('raises no notifications at all when nothing is configured to be watched', async () => {
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .persist();
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo)
      .persist();
    pool
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, fixtures.systemStatus)
      .persist();
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, fixtures.containers)
      .persist();

    const { app, deltas } = createApp();
    const instance = plugin(app);

    instance.start(validOptions, noopRestart);
    await flush();
    await flush();
    await flush();

    // An alarm the operator did not ask for teaches them to ignore the channel.
    const values = deltas.flatMap((delta) =>
      ((delta as { updates?: { values?: { path: string }[] }[] }).updates ?? []).flatMap(
        (update) => update.values ?? [],
      ),
    );
    expect(values.some((entry) => entry.path.startsWith('notifications.'))).toBe(false);

    instance.stop();
  });

  it('registers a PUT handler for each container it discovers', async () => {
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .persist();
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo)
      .persist();
    pool
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, fixtures.systemStatus)
      .persist();
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, fixtures.containers)
      .persist();

    const { app, puts } = createApp();
    const instance = plugin(app);

    instance.start(validOptions, noopRestart);
    await flush();
    await flush();
    await flush();

    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((entry) => entry.path.endsWith('.state'))).toBe(true);
    expect(puts.every((entry) => entry.context === 'vessels.self')).toBe(true);

    instance.stop();
  });

  it('registers PUT handlers with telemetry off, and none when control is off', async () => {
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .persist();
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo)
      .persist();
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, fixtures.systemStatus)
      .persist();
    // Served, so that a poller which should not exist would find containers
    // and register handlers for them — the test would then fail, as it should.
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, fixtures.containers)
      .persist();

    const { app, puts } = createApp();
    const instance = plugin(app);

    // Turning deltas off saves bandwidth; it is not a request to give up
    // control. The poll still runs, so the paths PUT writes to are still
    // discovered — they are simply never published as values.
    instance.start({ ...validOptions, telemetry: { level: 'off' } }, noopRestart);
    await flush();
    await flush();
    await flush();

    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((entry) => entry.path.endsWith('.state'))).toBe(true);

    instance.stop();

    // Control off is what removes them. Telemetry stays on here so the poller
    // definitely runs and definitely offers the keys: the handlers are absent
    // because control refused them, not because nothing was ever discovered.
    const second = createApp();
    const other = plugin(second.app);
    other.start({ ...validOptions, control: { allowPutControl: false } }, noopRestart);
    await flush();
    await flush();
    await flush();

    expect(second.puts).toHaveLength(0);

    other.stop();
  });

  it('publishes nothing when telemetry is off', async () => {
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .persist();
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo)
      .persist();
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, fixtures.systemStatus)
      .persist();

    const { app, deltas } = createApp();
    const instance = plugin(app);

    instance.start({ ...validOptions, telemetry: { level: 'off' } }, noopRestart);
    await flush();
    await flush();
    await flush();

    // No container list was even requested: the poller is not constructed.
    expect(deltas).toHaveLength(0);
    instance.stop();
  });

  it('comes up even when Portainer is unreachable, and says why', async () => {
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .replyWithError(new Error('connect ECONNREFUSED'));

    const { app, errors } = createApp();
    const instance = plugin(app);

    instance.start(validOptions, noopRestart);
    await flush();
    await flush();

    expect(errors.join(' ')).toMatch(/No Portainer instance reachable/);
    instance.stop();
  });

  it('redacts credentials before they reach any Signal K host callback', async () => {
    // The instance name is token-shaped, so it appears verbatim in the failure
    // message the plugin builds. setPluginError persists whatever it is given,
    // so the redaction has to happen before the callback, not only in app.error.
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .replyWithError(new Error('connect ECONNREFUSED'));

    const { app, statuses, errors } = createApp();
    const instance = plugin(app);

    instance.start(
      { instances: [{ name: 'ptr_boat', host: 'boat.test', apiKey: 'ptr_boat' }] },
      noopRestart,
    );
    await flush();
    await flush();

    expect(errors.join(' ')).toMatch(/No Portainer instance reachable/);
    expect([...statuses, ...errors].join(' ')).not.toContain('ptr_boat');
    instance.stop();
  });

  it('does not let an in-flight health check overwrite the stopped status', async () => {
    // The probe must fully succeed, otherwise it reports an error instead of a
    // status and the race this guards against is never exercised.
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo);
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);

    const { app, statuses } = createApp();
    const instance = plugin(app);

    instance.start(validOptions, noopRestart);
    instance.stop();
    await flush();
    await flush();

    // The probe started before stop(); its result belongs to a dead registry.
    expect(statuses.at(-1)).toBe('Stopped');
  });

  it('reports partial reachability rather than all-or-nothing', async () => {
    const boat = agent.get('https://boat.test:9443');
    boat
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    boat
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo);
    boat.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);
    agent
      .get('https://shore.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(403, { message: 'forbidden' });

    const { app, errors } = createApp();
    const instance = plugin(app);

    instance.start(
      {
        instances: [
          { name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' },
          { name: 'shore', host: 'shore.test', apiKey: 'ptr_shore' },
        ],
      },
      noopRestart,
    );
    await flush();
    await flush();

    expect(errors.join(' ')).toMatch(/1\/2 instances reachable/);
    expect(errors.join(' ')).toMatch(/shore/);
    instance.stop();
  });

  it('reports a swarm-enabled environment in the connected status', async () => {
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.swarmInfo);
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);

    const { app, statuses } = createApp();
    const instance = plugin(app);

    instance.start(validOptions, noopRestart);
    await flush();
    await flush();

    expect(statuses.some((s) => s.includes('swarm'))).toBe(true);
    instance.stop();
  });

  it('reports an unexpected start failure without throwing', () => {
    const { app, errors } = createApp();
    const instance = plugin(app);

    // A non-ConfigError thrown out of normalizeConfig's input handling.
    expect(() =>
      instance.start({ instances: 'not-an-array' } as object, noopRestart),
    ).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('stops cleanly when it never started', () => {
    const { app, statuses } = createApp();
    const instance = plugin(app);

    expect(() => instance.stop()).not.toThrow();
    expect(statuses.at(-1)).toBe('Stopped');
  });

  it('never writes a credential to the debug log', () => {
    const { app, debug } = createApp();
    const instance = plugin(app);

    instance.start(validOptions, noopRestart);
    expect(debug.join(' ')).not.toContain('ptr_boat');
    instance.stop();
  });
});

describe('the console endpoint', () => {
  it('is registered when the server can serve a WebSocket', () => {
    const { app, sockets } = createApp();
    const instance = plugin(app);

    instance.start({ ...validOptions, control: { allowPutControl: true } }, noopRestart);

    expect(sockets.map((socket) => socket.path)).toEqual(['/console']);
    instance.stop();
  });

  it('is absent, with a reason, on a server that cannot', () => {
    // Feature-detected rather than assumed: an older server has no such method,
    // and a console that cannot work should not be offered.
    const { app, debug } = createApp();
    const older = { ...app, registerWebSocket: undefined } as unknown as SignalKApp;
    const instance = plugin(older);

    instance.start({ ...validOptions, control: { allowPutControl: true } }, noopRestart);

    expect(debug.join('\n')).toContain('cannot serve a plugin WebSocket');
    instance.stop();
  });

  it('is not registered at all while control is disabled', () => {
    // Nothing to open a shell for: every mutating route is refused anyway.
    const { app, sockets } = createApp();
    const instance = plugin(app);

    instance.start({ ...validOptions, control: { allowPutControl: false } }, noopRestart);

    expect(sockets).toHaveLength(0);
    instance.stop();
  });
});

/**
 * The panel's environment picker, end to end through the plugin: the choice
 * has to reach the plugin options, or it is forgotten on the next restart and
 * the operator is back to editing configuration by hand.
 */
describe('saving the environment the panel picked', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const twoEnvironments = (times = 1): void => {
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment, fixtures.nasEnvironment])
      .times(times);
  };

  /** The plugin started, with its own routes mounted as the server mounts them. */
  const startWith = (
    harness: ReturnType<typeof createApp>,
    options: object = { instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }] },
  ) => {
    const instance = plugin(harness.app);
    instance.start(options, noopRestart);
    const router = express.Router();
    // Signal K hands plugins a router with an extra `access()` for route
    // scoping. This plugin never calls it, so a plain express Router is the
    // whole of what it uses.
    instance.registerWithRouter!(
      router as unknown as Parameters<NonNullable<typeof instance.registerWithRouter>>[0],
    );
    const server = express();
    server.use(router);
    return { instance, server };
  };

  it('writes the chosen id into the plugin options', async () => {
    twoEnvironments();
    const harness = createApp();
    const { instance, server } = startWith(harness);

    const res = await request(server).put('/api/environment').send({ id: 4 });

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]).toMatchObject({
      instances: [{ name: 'boat', environmentId: 4 }],
    });
    instance.stop();
  });

  it('leaves the rest of the configuration alone', async () => {
    // Saving the normalized config instead of the options as given would
    // rewrite fields the operator set — the host among them.
    twoEnvironments();
    const harness = createApp();
    const { instance, server } = startWith(harness, {
      instances: [
        {
          name: 'boat',
          host: 'boat.test',
          apiKey: 'ptr_boat',
          port: 9443,
          timeoutMs: 15000,
        },
      ],
      telemetry: { level: 'full', intervalSeconds: 45 },
    });

    await request(server).put('/api/environment').send({ id: 4 });

    expect(harness.saved[0]).toMatchObject({
      instances: [
        {
          name: 'boat',
          host: 'boat.test',
          apiKey: 'ptr_boat',
          port: 9443,
          timeoutMs: 15000,
          environmentId: 4,
        },
      ],
      telemetry: { level: 'full', intervalSeconds: 45 },
    });
    instance.stop();
  });

  it('clears a stale environment name, which the id would have overruled anyway', async () => {
    twoEnvironments();
    const harness = createApp();
    const { instance, server } = startWith(harness, {
      instances: [
        { name: 'boat', host: 'boat.test', apiKey: 'ptr_boat', environmentName: 'somewhere-else' },
      ],
    });

    await request(server).put('/api/environment').send({ id: 4 });

    expect(harness.saved[0]).toMatchObject({
      instances: [{ environmentId: 4, environmentName: '' }],
    });
    instance.stop();
  });

  it('selects anyway on a server that cannot save plugin options', async () => {
    twoEnvironments();
    const harness = createApp({ canSave: false });
    const { instance, server } = startWith(harness);

    const res = await request(server).put('/api/environment').send({ id: 4 });

    expect(res.status).toBe(200);
    expect(res.body.selected).toBe(4);
    expect(res.body.persisted).toBe(false);
    instance.stop();
  });

  it('reports a save that failed without losing the selection', async () => {
    twoEnvironments();
    const harness = createApp({ saveFails: true });
    const { instance, server } = startWith(harness);

    const res = await request(server).put('/api/environment').send({ id: 4 });

    expect(res.body.selected).toBe(4);
    expect(res.body.persisted).toBe(false);
    expect(res.body.warning).toContain('will not survive a restart');
    instance.stop();
  });
});
