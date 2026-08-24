import express from 'express';
import request from 'supertest';
import { normalizeConfig } from '../src/config';
import { registerRoutes } from '../src/facade';
import { InstanceRegistry } from '../src/registry';
import type { SelfContainer } from '../src/self';
import { asJson, createMockAgent, restoreGlobalDispatcher } from './support';
import type { MockAgent } from 'undici';

const noSelf: SelfContainer = { inContainer: false, source: 'none', identified: false };

const logged: string[] = [];

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
    log: (message) => logged.push(message),
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
    logged.length = 0;
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

  it('allows the admin UI reached through a reverse proxy', async () => {
    // What nginx in front of Signal K looks like from in here: the browser
    // used https://boat.example:4443, the request that arrived says
    // http://127.0.0.1:3000. Comparing those refused the panel's own writes.
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'https://boat.example:4443')
      .set('Host', '127.0.0.1:3000')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'boat.example:4443')
      .set('Sec-Fetch-Site', 'same-origin');

    expect(res.status).not.toBe(403);
  });

  it('allows a proxied write from a browser too old to say where it came from', async () => {
    // No Sec-Fetch-Site: Safari before 16.4, Firefox before 90. The forwarded
    // address is all there is to compare against.
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'https://boat.example:4443')
      .set('Host', 'boat.example:4443')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).not.toBe(403);
  });

  it('allows a proxy that forwards the port separately from the host', async () => {
    // `proxy_set_header Host $host` drops the port; X-Forwarded-Port is what
    // puts it back.
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'https://boat.example:4443')
      .set('Host', 'boat.example')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Port', '4443');

    expect(res.status).not.toBe(403);
  });

  it('reads the RFC 7239 Forwarded header as well', async () => {
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'https://boat.example:4443')
      .set('Host', '127.0.0.1:3000')
      .set('Forwarded', 'for=10.0.0.9;host="boat.example:4443";proto=https');

    expect(res.status).not.toBe(403);
  });

  it('ignores a port the scheme already implies', async () => {
    // A browser writes https://boat.example, never https://boat.example:443.
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'https://BOAT.example')
      .set('Host', 'boat.example:443')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).not.toBe(403);
  });

  it('still refuses another site when the proxy headers are ours', async () => {
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'https://not-the-boat.example')
      .set('Host', '127.0.0.1:3000')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'boat.example:4443');

    expect(res.status).toBe(403);
  });

  it('refuses an opaque origin', async () => {
    // A sandboxed frame sends the literal string; it is nobody's origin.
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'null')
      .set('Host', '127.0.0.1:3000');

    expect(res.status).toBe(403);
  });

  it('refuses a plain-http origin when the proxy says the browser used https', async () => {
    // TLS ends at the proxy, so what arrives here is http — but the admin UI
    // is https, and a page at http://boat.example is one anybody sharing the
    // marina wifi can serve. The forwarded scheme is the one that counts.
    const res = await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'http://boat.example')
      .set('Host', 'boat.example')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).toBe(403);
  });

  it('says in the log which two addresses did not match', async () => {
    // The body a cross-site page is not allowed to read is also the body the
    // operator cannot see; the log is where a proxy misconfiguration is found.
    await request(app())
      .post('/api/containers/mosquitto/stop')
      .set('Origin', 'https://not-the-boat.example')
      .set('Host', 'boat.example:4443')
      .set('X-Forwarded-Proto', 'https');

    expect(logged.join('\n')).toContain(
      'https://not-the-boat.example is not https://boat.example:4443',
    );
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
