import type { MockAgent } from 'undici';
import { normalizeConfig, type PluginConfig } from '../src/config';
import {
  PutHandlers,
  replaceKnownContainers,
  type ActionHandler,
  type ActionResult,
  type KnownContainer,
} from '../src/put';
import { InstanceRegistry } from '../src/registry';
import type { SelfContainer } from '../src/self';
import * as fixtures from './fixtures';
import { createMockAgent } from './support';

const SELF_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const noSelf: SelfContainer = { inContainer: false, source: 'none', identified: false };
const selfContainer: SelfContainer = {
  inContainer: true,
  id: SELF_ID,
  shortId: SELF_ID.slice(0, 12),
  source: 'cgroup',
  identified: true,
};

const instances = normalizeConfig({
  instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }],
}).instances;

const control = (overrides: Partial<PluginConfig['control']> = {}): PluginConfig['control'] => ({
  allowPutControl: true,
  allowDestructive: false,
  allowSelfManagement: false,
  watchdog: [],
  ...overrides,
});

describe('PutHandlers', () => {
  let agent: MockAgent;
  let registered: { path: string; handler: ActionHandler }[];
  let logs: string[];

  beforeEach(() => {
    agent = createMockAgent();
    registered = [];
    logs = [];
  });

  afterEach(async () => {
    await agent.close();
  });

  const build = (
    opts: {
      control?: PluginConfig['control'];
      self?: SelfContainer;
      registry?: InstanceRegistry;
      containers?: Record<string, { id: string; name?: string }>;
    } = {},
  ) =>
    new PutHandlers(
      {
        registry: () => opts.registry ?? new InstanceRegistry(instances),
        config: () =>
          ({
            instances: [],
            telemetry: {
              level: 'health' as const,
              intervalSeconds: 30,

              pathPrefix: 'system.docker',
            },
            control: opts.control ?? control(),
          }) as PluginConfig,
        self: () => opts.self ?? noSelf,
        log: (message) => logs.push(message),
        register: (_context, path, handler) => registered.push({ path, handler }),
      },
      (instance, key) =>
        (opts.containers ?? { 'boat/influx': { id: 'c1f0e2a3b4c5', name: 'influx' } })[
          `${instance}/${key}`
        ],
    );

  /** Drives one handler and resolves with its final result. */
  const put = async (handler: ActionHandler, value: unknown): Promise<ActionResult> => {
    let settle: (result: ActionResult) => void = () => {};
    const done = new Promise<ActionResult>((resolve) => {
      settle = resolve;
    });
    const immediate = handler('vessels.self', 'x', value, settle);
    if (immediate.state !== 'PENDING') return immediate;
    return done;
  };

  const interceptEnvironment = () =>
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  describe('registration', () => {
    it('registers one handler per container key, on the state path', () => {
      build().register('boat', ['influx', 'ais_logger'], 'system.docker');

      expect(registered.map((entry) => entry.path)).toEqual([
        'system.docker.boat.containers.influx.state',
        'system.docker.boat.containers.ais_logger.state',
      ]);
    });

    it('registers a path only once, however many polls see it', () => {
      const puts = build();
      puts.register('boat', ['influx'], 'system.docker');
      puts.register('boat', ['influx'], 'system.docker');

      expect(registered).toHaveLength(1);
    });

    it('registers nothing when control is disabled', () => {
      build({ control: control({ allowPutControl: false }) }).register(
        'boat',
        ['influx'],
        'system.docker',
      );

      expect(registered).toHaveLength(0);
    });
  });

  describe('handling a write', () => {
    const handlerFor = (opts: Parameters<typeof build>[0] = {}, key = 'influx'): ActionHandler => {
      build(opts).register('boat', [key], 'system.docker');
      const handler = registered.at(-1)?.handler;
      if (!handler) throw new Error('no handler registered');
      return handler;
    };

    it.each([
      ['running', 'start'],
      ['stopped', 'stop'],
      ['restart', 'restart'],
    ])('maps %s to the %s call', async (value, dockerPath) => {
      interceptEnvironment();
      agent
        .get('https://boat.test:9443')
        .intercept({
          path: `/api/endpoints/1/docker/containers/c1f0e2a3b4c5/${dockerPath}`,
          method: 'POST',
        })
        .reply(204, '');

      const result = await put(handlerFor({ registry: new InstanceRegistry(instances) }), value);

      expect(result).toMatchObject({ state: 'COMPLETED', statusCode: 200 });
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('accepts the value whatever its case', async () => {
      interceptEnvironment();
      agent
        .get('https://boat.test:9443')
        .intercept({
          path: '/api/endpoints/1/docker/containers/c1f0e2a3b4c5/stop',
          method: 'POST',
        })
        .reply(204, '');

      const result = await put(
        handlerFor({ registry: new InstanceRegistry(instances) }),
        'Stopped',
      );

      expect(result.state).toBe('COMPLETED');
    });

    it('refuses a value it does not understand, without contacting Portainer', async () => {
      const result = await put(handlerFor(), 'obliterate');

      expect(result).toMatchObject({ state: 'FAILED', statusCode: 400 });
      expect(result.message).toContain('running, stopped, restart');
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('refuses when control is disabled after the handler was registered', async () => {
      // Signal K keeps the handler it was given, so turning control off in the
      // plugin configuration has to be honoured by the handler itself — there
      // is no way to unregister it.
      let live = control();
      const puts = new PutHandlers(
        {
          registry: () => new InstanceRegistry(instances),
          config: () => ({ control: live }) as PluginConfig,
          self: () => noSelf,
          log: (message) => logs.push(message),
          register: (_context, path, handler) => registered.push({ path, handler }),
        },
        () => ({ id: 'c1f0e2a3b4c5' }),
      );
      puts.register('boat', ['influx'], 'system.docker');
      const handler = registered.at(-1)?.handler as ActionHandler;

      live = control({ allowPutControl: false });
      const result = await put(handler, 'stopped');

      expect(result).toMatchObject({ state: 'FAILED', statusCode: 403 });
      // And nothing was sent to Portainer.
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('refuses to act on the container running Signal K', async () => {
      const result = await put(
        handlerFor(
          {
            self: selfContainer,
            containers: { 'boat/signalk': { id: SELF_ID, name: 'signalk' } },
          },
          'signalk',
        ),
        'stopped',
      );

      expect(result).toMatchObject({ state: 'FAILED', statusCode: 403 });
      expect(result.message).toContain('running Signal K');
      // Nothing was sent: no interceptor was registered at all.
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('allows the Signal K container once self-management is enabled', async () => {
      interceptEnvironment();
      agent
        .get('https://boat.test:9443')
        .intercept({
          path: `/api/endpoints/1/docker/containers/${SELF_ID}/restart`,
          method: 'POST',
        })
        .reply(204, '');

      const result = await put(
        handlerFor(
          {
            self: selfContainer,
            control: control({ allowSelfManagement: true }),
            containers: { 'boat/signalk': { id: SELF_ID } },
            registry: new InstanceRegistry(instances),
          },
          'signalk',
        ),
        'restart',
      );

      expect(result.state).toBe('COMPLETED');
    });

    it('reports a container it no longer knows about', async () => {
      const result = await put(handlerFor({ containers: {} }), 'stopped');

      expect(result).toMatchObject({ state: 'FAILED', statusCode: 404 });
    });

    it('reports a Portainer failure rather than claiming success', async () => {
      interceptEnvironment();
      agent
        .get('https://boat.test:9443')
        .intercept({
          path: '/api/endpoints/1/docker/containers/c1f0e2a3b4c5/stop',
          method: 'POST',
        })
        .reply(409, { message: 'container already stopped' });

      const result = await put(
        handlerFor({ registry: new InstanceRegistry(instances) }),
        'stopped',
      );

      expect(result).toMatchObject({ state: 'FAILED', statusCode: 502 });
      expect(logs.join('\n')).toContain('PUT');
    });

    it('answers PENDING first, because a stop can take the full timeout', () => {
      const handler = handlerFor({ registry: new InstanceRegistry(instances) });
      interceptEnvironment();
      agent
        .get('https://boat.test:9443')
        .intercept({
          path: '/api/endpoints/1/docker/containers/c1f0e2a3b4c5/stop',
          method: 'POST',
        })
        .reply(204, '');

      const immediate = handler('vessels.self', 'x', 'stopped', () => {});

      expect(immediate).toEqual({ state: 'PENDING' });
    });
  });
});

describe('replaceKnownContainers', () => {
  const known = (entries: Record<string, KnownContainer>) =>
    new Map<string, KnownContainer>(Object.entries(entries));

  it('forgets a container that is no longer there', () => {
    // Merging instead would leave the key resolving to an id that no longer
    // exists: a PUT to its path reaches Docker and comes back a gateway error
    // rather than saying plainly that the container is gone.
    const before = known({
      'boat/influx': { key: 'influx', id: 'aaa111' },
      'boat/ais': { key: 'ais', id: 'bbb222' },
    });

    const after = replaceKnownContainers(before, 'boat', [{ key: 'influx', id: 'aaa111' }]);

    expect([...after.keys()]).toEqual(['boat/influx']);
  });

  it('picks up a container that has appeared, and a new id for an old key', () => {
    const before = known({ 'boat/influx': { key: 'influx', id: 'aaa111' } });

    const after = replaceKnownContainers(before, 'boat', [
      // Same key, recreated container: the id must follow.
      { key: 'influx', id: 'ccc333' },
      { key: 'ais', id: 'ddd444' },
    ]);

    expect(after.get('boat/influx')?.id).toBe('ccc333');
    expect(after.get('boat/ais')?.id).toBe('ddd444');
  });

  it('says nothing about the instances this poll did not look at', () => {
    const before = known({
      'boat/influx': { key: 'influx', id: 'aaa111' },
      'shore/backup': { key: 'backup', id: 'eee555' },
    });

    const after = replaceKnownContainers(before, 'boat', []);

    expect(after.get('shore/backup')?.id).toBe('eee555');
    expect(after.has('boat/influx')).toBe(false);
  });

  it('does not mutate the map it was given', () => {
    const before = known({ 'boat/influx': { key: 'influx', id: 'aaa111' } });

    replaceKnownContainers(before, 'boat', []);

    expect(before.has('boat/influx')).toBe(true);
  });
});
