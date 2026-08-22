import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import { PortainerError } from '../src/errors';
import { registerRoutes, instanceParam } from '../src/facade';
import { InstanceRegistry, UnknownInstanceError } from '../src/registry';
import * as fixtures from './fixtures';
import { createMockAgent } from './support';

const buildApp = (registry: InstanceRegistry | undefined) => {
  const app = express();
  const router = express.Router();
  registerRoutes(router, { registry: () => registry, log: () => {} });
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
