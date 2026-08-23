import express from 'express';
import request from 'supertest';
import { normalizeConfig } from '../src/config';
import { registerRoutes } from '../src/facade';
import { InstanceRegistry } from '../src/registry';
import type { SelfContainer } from '../src/self';
import { asJson, createMockAgent, restoreGlobalDispatcher } from './support';
import type { MockAgent } from 'undici';

const noSelf: SelfContainer = { inContainer: false, source: 'none', identified: false };

const buildApp = (registry: InstanceRegistry | undefined) => {
  const app = express();
  const router = express.Router();
  registerRoutes(router, {
    registry: () => registry,
    config: () => ({
      instances: [],
      problems: [],
      telemetry: { level: 'off' as const, intervalSeconds: 30, pathPrefix: 'x' },
      control: {
        allowPutControl: true,
        allowDestructive: true,
        allowSelfManagement: false,
        putContainers: [],
        watchdog: [],
      },
    }),
    self: () => noSelf,
    log: () => {},
  });
  app.use(router);
  return app;
};

const config = normalizeConfig({
  instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }],
}).instances;

describe('requests from another site', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

  const app = () => buildApp(new InstanceRegistry(config));

  it('refuses a cross-site stop before it reaches Portainer', async () => {
    // The attack this exists for: a page the operator visits on marina wifi
    // posts to their own Signal K. No body means no preflight, so the browser
    // sends it with the session cookie attached and only hides the answer.
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'https://not-the-boat.example');

    expect(res.status).toBe(403);
    expect(asJson(res.body).error).toContain('another site');
    // Nothing was asked of Portainer: no interceptor was ever registered.
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('refuses a cross-site delete', async () => {
    const res = await request(app())
      .delete('/api/containers/abc123def456')
      .set('Origin', 'https://not-the-boat.example');

    expect(res.status).toBe(403);
  });

  it('refuses when the browser says the request came from elsewhere', async () => {
    const res = await request(app())
      .post('/api/containers/mosquitto/kill')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(res.status).toBe(403);
  });

  it('allows the admin UI, which is same-origin', async () => {
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'http://127.0.0.1:3000')
      .set('Host', '127.0.0.1:3000')
      .set('Sec-Fetch-Site', 'same-origin');

    // Past the guard: it fails later, on Portainer, which is what we want.
    expect(res.status).not.toBe(403);
  });

  it('leaves a non-browser caller alone', async () => {
    // curl, another plugin, an automation — no Origin, no Sec-Fetch-Site.
    // Signal K has already authenticated these; breaking them would be worse.
    const res = await request(app()).post('/api/containers/mosquitto/stop');

    expect(res.status).not.toBe(403);
  });

  it('never blocks a read', async () => {
    const res = await request(app())
      .get('/api/instances')
      .set('Origin', 'https://not-the-boat.example');

    expect(res.status).toBe(200);
  });
});
