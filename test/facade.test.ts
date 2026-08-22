import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import { registerRoutes, instanceParam } from '../src/facade';
import { InstanceRegistry } from '../src/registry';
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

describe('instanceParam', () => {
  it('reads a non-empty ?instance= and otherwise falls back to the default', () => {
    expect(instanceParam({ query: { instance: 'shore' } } as never)).toBe('shore');
    expect(instanceParam({ query: { instance: '' } } as never)).toBeUndefined();
    expect(instanceParam({ query: {} } as never)).toBeUndefined();
    expect(instanceParam({ query: { instance: ['a', 'b'] } } as never)).toBeUndefined();
  });
});
