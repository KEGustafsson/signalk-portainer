import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import type { PluginConfig } from '../src/config';
import { PortainerError } from '../src/errors';
import type { SelfContainer } from '../src/self';
import { registerRoutes, instanceParam } from '../src/facade';
import { InstanceRegistry, UnknownInstanceError } from '../src/registry';
import * as fixtures from './fixtures';
import { createMockAgent } from './support';

const noSelf: SelfContainer = { inContainer: false, source: 'none', identified: false };

const control = (overrides: Partial<PluginConfig['control']> = {}): PluginConfig['control'] => ({
  allowPutControl: true,
  allowDestructive: false,
  allowSelfManagement: false,
  watchdog: [],
  ...overrides,
});

const buildApp = (
  registry: InstanceRegistry | undefined,
  opts: { control?: PluginConfig['control']; self?: SelfContainer } = {},
) => {
  const app = express();
  const router = express.Router();
  registerRoutes(router, {
    registry: () => registry,
    config: () =>
      registry
        ? ({
            instances: [],
            telemetry: { enabled: false, intervalSeconds: 30, emitStats: false, pathPrefix: 'x' },
            control: opts.control ?? control(),
          } as PluginConfig)
        : undefined,
    self: () => opts.self ?? noSelf,
    log: () => {},
  });
  app.use(router);
  return app;
};

const config = normalizeConfig({
  instances: [
    { name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' },
    { name: 'shore', host: 'shore.test', apiKey: 'ptr_shore' },
  ],
}).instances;

describe('facade', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const interceptReachable = (origin: string): void => {
    const pool = agent.get(origin);
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo);
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);
  };

  it('answers 503 before the plugin has started', async () => {
    const res = await request(buildApp(undefined)).get('/api/instances');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not started/);
  });

  it('lists instances and marks the default, without leaking tokens', async () => {
    const registry = new InstanceRegistry(config);
    const res = await request(buildApp(registry)).get('/api/instances');

    expect(res.status).toBe(200);
    expect(res.body.instances).toHaveLength(2);
    expect(res.body.instances[0]).toMatchObject({ name: 'boat', isDefault: true });
    expect(res.body.instances[1]).toMatchObject({ name: 'shore', isDefault: false });
    expect(JSON.stringify(res.body)).not.toContain('ptr_boat');
    registry.close();
  });

  it('reports ok only when every instance is reachable', async () => {
    interceptReachable('https://boat.test:9443');
    agent
      .get('https://shore.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(404, { message: 'nope' });

    const registry = new InstanceRegistry(config);
    const res = await request(buildApp(registry)).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.instances[0].reachable).toBe(true);
    expect(res.body.instances[1].reachable).toBe(false);
    registry.close();
  });
});

describe('facade read routes', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const boat = () => agent.get('https://boat.test:9443');

  const withEnvironment = (times = 1) =>
    boat()
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .times(times);

  const app = () => buildApp(new InstanceRegistry(config));

  it('lists environments and marks the selected one', async () => {
    withEnvironment(2);
    const res = await request(app()).get('/api/environments');

    expect(res.status).toBe(200);
    expect(res.body.selected).toBe(1);
    expect(res.body.environments[0]).toMatchObject({
      id: 1,
      name: 'local',
      health: 'up',
      isSelected: true,
    });
  });

  it('echoes which instance served the request', async () => {
    withEnvironment(2);
    const res = await request(app()).get('/api/environments');
    expect(res.body.instance).toBe('boat');
  });

  it('routes ?instance= to that instance', async () => {
    agent
      .get('https://shore.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .times(2);

    const res = await request(app()).get('/api/environments?instance=shore');

    expect(res.status).toBe(200);
    expect(res.body.instance).toBe('shore');
  });

  it('404s on an unknown ?instance=', async () => {
    const res = await request(app()).get('/api/environments?instance=nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nope');
  });

  it('lists containers, and passes ?all= through', async () => {
    withEnvironment();
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, fixtures.containers);

    const res = await request(app()).get('/api/containers?all=true');

    expect(res.status).toBe(200);
    expect(res.body.containers).toHaveLength(2);
  });

  it('inspects a container', async () => {
    withEnvironment();
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/c1f0e2a3b4c5/json', method: 'GET' })
      .reply(200, fixtures.containerInspect);

    const res = await request(app()).get('/api/containers/c1f0e2a3b4c5');

    expect(res.status).toBe(200);
    expect(res.body.container.Name).toBe('/signalk_influxdb');
  });

  it('lists stacks scoped to the environment', async () => {
    withEnvironment();
    boat().intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);

    const res = await request(app()).get('/api/stacks');

    expect(res.body.stacks.map((s: { Name: string }) => s.Name)).toEqual(['signalk']);
  });

  it('serves a stack file for a stack in this environment', async () => {
    withEnvironment();
    boat().intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);
    boat()
      .intercept({ path: '/api/stacks/3/file', method: 'GET' })
      .reply(200, { StackFileContent: 'services: {}' });

    const res = await request(app()).get('/api/stacks/3/file');

    expect(res.status).toBe(200);
    expect(res.body.content).toContain('services');
  });

  it('404s a stack file belonging to another environment', async () => {
    withEnvironment();
    boat().intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);

    // Fixture stack 9 lives in EndpointId 4; this instance is bound to 1.
    const res = await request(app()).get('/api/stacks/9/file');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/does not belong to this environment/);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('rejects a non-numeric stack id before reaching Portainer', async () => {
    const res = await request(app()).get('/api/stacks/abc/file');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not a number');
  });

  it('serves images, volumes and networks', async () => {
    withEnvironment(3);
    boat()
      .intercept({ path: '/api/endpoints/1/docker/images/json', method: 'GET' })
      .reply(200, fixtures.images);
    boat()
      .intercept({ path: '/api/endpoints/1/docker/volumes', method: 'GET' })
      .reply(200, fixtures.volumeList);
    boat()
      .intercept({ path: '/api/endpoints/1/docker/networks', method: 'GET' })
      .reply(200, fixtures.networks);

    expect((await request(app()).get('/api/images')).body.images).toHaveLength(1);
    expect((await request(app()).get('/api/volumes')).body.volumes).toHaveLength(1);
    expect((await request(app()).get('/api/networks')).body.networks).toHaveLength(1);
  });
});

describe('facade swarm routes', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const probe = (info: object) => {
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool.intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' }).reply(200, info);
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);
    return pool;
  };

  it('404s with an explanation when the daemon is not a swarm', async () => {
    probe(fixtures.standaloneInfo);
    const res = await request(buildApp(new InstanceRegistry(config))).get('/api/swarm/services');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not a Swarm');
    expect(res.body.hint).toContain('not an active swarm member');
  });

  it('serves services and nodes when the daemon is a swarm member', async () => {
    const pool = probe(fixtures.swarmInfo);
    pool
      .intercept({ path: '/api/endpoints/1/docker/services', method: 'GET' })
      .reply(200, [{ ID: 'svc1', Spec: { Name: 'web' } }]);

    const res = await request(buildApp(new InstanceRegistry(config))).get('/api/swarm/services');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);
  });
});

describe('facade container lifecycle', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const SELF_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
  const selfContainer: SelfContainer = {
    inContainer: true,
    id: SELF_ID,
    shortId: SELF_ID.slice(0, 12),
    source: 'cgroup',
    identified: true,
  };

  const boat = () => agent.get('https://boat.test:9443');
  const withEnvironment = () =>
    boat()
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  it.each([
    ['start', 'start'],
    ['stop', 'stop'],
    ['restart', 'restart'],
    ['kill', 'kill'],
  ])('performs %s through the docker proxy', async (action, dockerPath) => {
    withEnvironment();
    boat()
      .intercept({
        path: `/api/endpoints/1/docker/containers/abc123def456/${dockerPath}`,
        method: 'POST',
      })
      .reply(204, '');

    const res = await request(buildApp(new InstanceRegistry(config))).post(
      `/api/containers/abc123def456/${action}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action, ok: true });
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('rejects an unknown action before contacting Portainer', async () => {
    const res = await request(buildApp(new InstanceRegistry(config))).post(
      '/api/containers/abc123def456/destroy',
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown container action');
    expect(res.body.hint).toContain('start, stop, restart, kill');
  });

  it('refuses every action on the container running Signal K', async () => {
    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });

    for (const action of ['start', 'stop', 'restart', 'kill']) {
      const res = await request(app).post(`/api/containers/${SELF_ID}/${action}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('running Signal K');
    }
    // Nothing was sent to Portainer: no interceptor was registered at all.
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('recognises itself from the short id the UI actually sends', async () => {
    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });

    const res = await request(app).post(`/api/containers/${SELF_ID.slice(0, 12)}/stop`);

    expect(res.status).toBe(403);
  });

  it('allows managing the Signal K container once explicitly enabled', async () => {
    withEnvironment();
    boat()
      .intercept({ path: `/api/endpoints/1/docker/containers/${SELF_ID}/restart`, method: 'POST' })
      .reply(204, '');

    const app = buildApp(new InstanceRegistry(config), {
      self: selfContainer,
      control: control({ allowSelfManagement: true }),
    });

    const res = await request(app).post(`/api/containers/${SELF_ID}/restart`);

    expect(res.status).toBe(200);
  });

  it('leaves other containers alone when self-protection is active', async () => {
    withEnvironment();
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/ffffffffffff/stop', method: 'POST' })
      .reply(204, '');

    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });
    const res = await request(app).post('/api/containers/ffffffffffff/stop');

    expect(res.status).toBe(200);
  });

  it('refuses all mutations when control is disabled', async () => {
    const app = buildApp(new InstanceRegistry(config), {
      control: control({ allowPutControl: false }),
    });

    const stop = await request(app).post('/api/containers/abc123def456/stop');
    const remove = await request(app).delete('/api/containers/abc123def456');

    expect(stop.status).toBe(403);
    expect(stop.body.error).toContain('Container control is disabled');
    expect(remove.status).toBe(403);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('refuses removal unless destructive operations are enabled', async () => {
    const app = buildApp(new InstanceRegistry(config));
    const res = await request(app).delete('/api/containers/abc123def456');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Destructive operations are disabled');
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('removes a container without its volumes by default', async () => {
    withEnvironment();
    boat()
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc123def456?force=false&v=false',
        method: 'DELETE',
      })
      .reply(204, '');

    const app = buildApp(new InstanceRegistry(config), {
      control: control({ allowDestructive: true }),
    });
    const res = await request(app).delete('/api/containers/abc123def456');

    expect(res.status).toBe(200);
    expect(res.body.removeVolumes).toBe(false);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('removes volumes only when asked explicitly', async () => {
    withEnvironment();
    boat()
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc123def456?force=true&v=true',
        method: 'DELETE',
      })
      .reply(204, '');

    const app = buildApp(new InstanceRegistry(config), {
      control: control({ allowDestructive: true }),
    });
    const res = await request(app).delete(
      '/api/containers/abc123def456?force=true&removeVolumes=true',
    );

    expect(res.status).toBe(200);
    expect(res.body.removeVolumes).toBe(true);
  });

  it('still refuses to remove the Signal K container even when destructive is on', async () => {
    const app = buildApp(new InstanceRegistry(config), {
      self: selfContainer,
      control: control({ allowDestructive: true }),
    });

    const res = await request(app).delete(`/api/containers/${SELF_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('running Signal K');
  });
});

describe('facade control surface', () => {
  it('reports what the UI may offer, and that protection is active', async () => {
    const res = await request(
      buildApp(new InstanceRegistry(config), {
        self: {
          inContainer: true,
          id: 'a'.repeat(64),
          shortId: 'a'.repeat(12),
          source: 'cgroup',
          identified: true,
        },
      }),
    ).get('/api/control');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      allowPutControl: true,
      allowDestructive: false,
      allowSelfManagement: false,
    });
    expect(res.body.self.protectionActive).toBe(true);
    expect(res.body.self.warning).toBeUndefined();
  });

  it('warns when it is containerised but cannot identify itself', async () => {
    const res = await request(
      buildApp(new InstanceRegistry(config), {
        self: { inContainer: true, source: 'none', identified: false },
      }),
    ).get('/api/control');

    expect(res.body.self.protectionActive).toBe(false);
    expect(res.body.self.warning).toContain('unable to identify');
  });

  it('reports protection inactive when self-management is enabled', async () => {
    const res = await request(
      buildApp(new InstanceRegistry(config), {
        self: {
          inContainer: true,
          id: 'a'.repeat(64),
          shortId: 'a'.repeat(12),
          source: 'cgroup',
          identified: true,
        },
        control: control({ allowSelfManagement: true }),
      }),
    ).get('/api/control');

    expect(res.body.self.protectionActive).toBe(false);
  });
});

describe('facade error mapping', () => {
  const failingRegistry = (cause: unknown): InstanceRegistry =>
    ({
      get names(): string[] {
        throw cause;
      },
    }) as unknown as InstanceRegistry;

  it('maps an unknown instance to 404', async () => {
    const registry = failingRegistry(new UnknownInstanceError('nope', ['boat']));
    const res = await request(buildApp(registry)).get('/api/instances');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nope');
  });

  it('maps a Portainer failure to its facade status, with the hint', async () => {
    const registry = failingRegistry(
      new PortainerError({
        status: 404,
        method: 'GET',
        path: '/api/endpoints',
        message: 'not found',
        hint: 'ids are creation-order',
      }),
    );
    const res = await request(buildApp(registry)).get('/api/instances');

    expect(res.status).toBe(404);
    expect(res.body.portainerStatus).toBe(404);
    expect(res.body.hint).toContain('creation-order');
  });

  it('maps an unexpected failure to 500', async () => {
    const res = await request(buildApp(failingRegistry(new Error('kaboom')))).get('/api/instances');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('kaboom');
  });

  it('handles a thrown non-Error', async () => {
    const res = await request(buildApp(failingRegistry('odd'))).get('/api/instances');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('odd');
  });
});

describe('instanceParam', () => {
  it('reads a non-empty ?instance= and otherwise falls back to the default', () => {
    expect(instanceParam({ query: { instance: 'shore' } } as never)).toBe('shore');
    expect(instanceParam({ query: { instance: '' } } as never)).toBeUndefined();
    expect(instanceParam({ query: {} } as never)).toBeUndefined();
    expect(instanceParam({ query: { instance: ['a', 'b'] } } as never)).toBeUndefined();
  });
});
