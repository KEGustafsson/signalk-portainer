import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import type { PluginConfig } from '../src/config';
import { PortainerError } from '../src/errors';
import type { SelfContainer } from '../src/self';
import { registerRoutes, instanceParam } from '../src/facade';
import type { LogFrame } from '../src/logframes';
import { InstanceRegistry, UnknownInstanceError } from '../src/registry';
import { StreamLimiter } from '../src/streamlimit';
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
  opts: {
    control?: PluginConfig['control'];
    self?: SelfContainer;
    log?: (message: string) => void;
    streams?: StreamLimiter;
    keepalive?: number;
  } = {},
) => {
  const app = express();
  const router = express.Router();
  registerRoutes(router, {
    registry: () => registry,
    config: () =>
      registry
        ? ({
            instances: [],
            telemetry: {
              level: 'off' as const,
              intervalSeconds: 30,
              emitStats: false,
              pathPrefix: 'x',
            },
            control: opts.control ?? control(),
          } as PluginConfig)
        : undefined,
    self: () => opts.self ?? noSelf,
    log: opts.log ?? (() => {}),
    ...(opts.streams ? { streams: opts.streams } : {}),
    ...(opts.keepalive ? { keepaliveMs: opts.keepalive } : {}),
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

describe('facade logs', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  /** One Docker log frame: 8-byte header then payload. */
  const frame = (stream: 1 | 2, text: string): Buffer => {
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  const boat = () => agent.get('https://boat.test:9443');
  const withEnvironment = () =>
    boat()
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  it("returns the log as lines, with each line's stream", async () => {
    withEnvironment();
    boat()
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc123def456/logs?stdout=true&stderr=true&tail=200',
        method: 'GET',
      })
      .reply(200, Buffer.concat([frame(1, 'listening\n'), frame(2, 'warning\n')]));

    const res = await request(buildApp(new InstanceRegistry(config))).get(
      '/api/containers/abc123def456/logs',
    );

    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([
      { stream: 'stdout', text: 'listening' },
      { stream: 'stderr', text: 'warning' },
    ]);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('passes tail, since and timestamps through to Docker', async () => {
    withEnvironment();
    boat()
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc123def456/logs?stdout=true&stderr=true&tail=50&since=1700000000&timestamps=true',
        method: 'GET',
      })
      .reply(200, frame(1, 'x\n'));

    const res = await request(buildApp(new InstanceRegistry(config))).get(
      '/api/containers/abc123def456/logs?tail=50&since=1700000000&timestamps=true',
    );

    expect(res.status).toBe(200);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('ignores a tail that is not a usable number', async () => {
    withEnvironment();
    boat()
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc123def456/logs?stdout=true&stderr=true&tail=200',
        method: 'GET',
      })
      .reply(200, frame(1, 'x\n'));

    const res = await request(buildApp(new InstanceRegistry(config))).get(
      '/api/containers/abc123def456/logs?tail=lots',
    );

    expect(res.status).toBe(200);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it("reads a TTY container's unframed output", async () => {
    withEnvironment();
    boat()
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc123def456/logs?stdout=true&stderr=true&tail=200',
        method: 'GET',
      })
      .reply(200, 'plain tty output\nsecond line\n');

    const res = await request(buildApp(new InstanceRegistry(config))).get(
      '/api/containers/abc123def456/logs',
    );

    expect(res.body.lines).toEqual([
      { stream: 'stdout', text: 'plain tty output' },
      { stream: 'stdout', text: 'second line' },
    ]);
  });

  it('maps a Portainer failure to the facade status', async () => {
    withEnvironment();
    boat()
      .intercept({
        path: '/api/endpoints/1/docker/containers/gone/logs?stdout=true&stderr=true&tail=200',
        method: 'GET',
      })
      .reply(404, { message: 'No such container' });

    const res = await request(buildApp(new InstanceRegistry(config))).get(
      '/api/containers/gone/logs',
    );

    expect(res.status).toBe(404);
  });
});

describe('facade log streaming', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const frame = (stream: 1 | 2, text: string): Buffer => {
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  const boat = () => agent.get('https://boat.test:9443');
  const streamPath =
    '/api/endpoints/1/docker/containers/abc123def456/logs?stdout=true&stderr=true&tail=200&follow=true';

  const withEnvironment = () =>
    boat()
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  /** The events in an SSE body, as { event, data } pairs. */
  const events = (body: string) =>
    body
      .split('\n\n')
      .filter((block) => block.trim().length > 0)
      .map((block) => {
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
        return { event, data: data ? (JSON.parse(data) as unknown) : undefined };
      });

  it('relays each line as an event and ends when Docker does', async () => {
    withEnvironment();
    boat()
      .intercept({ path: streamPath, method: 'GET' })
      .reply(200, Buffer.concat([frame(1, 'listening\n'), frame(2, 'warning\n')]));

    const res = await request(buildApp(new InstanceRegistry(config))).get(
      '/api/containers/abc123def456/logs/stream',
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // Proxies that buffer would hold every line until a stream that never ends.
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(events(res.text)).toEqual([
      { event: 'open', data: { id: 'abc123def456', instance: 'boat' } },
      { event: 'message', data: { stream: 'stdout', text: 'listening' } },
      { event: 'message', data: { stream: 'stderr', text: 'warning' } },
      { event: 'end', data: {} },
    ]);
  });

  it('reports a failure as a status while nothing has been sent yet', async () => {
    withEnvironment();
    boat()
      .intercept({ path: streamPath, method: 'GET' })
      .reply(404, { message: 'No such container' });

    const res = await request(buildApp(new InstanceRegistry(config))).get(
      '/api/containers/abc123def456/logs/stream',
    );

    // The stream never opened, so this can still be an ordinary error response.
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('failed with 404');
  });

  it('answers 404 for an instance that is not configured', async () => {
    const res = await request(buildApp(new InstanceRegistry(config))).get(
      '/api/containers/abc/logs/stream?instance=nowhere',
    );

    expect(res.status).toBe(404);
  });

  it('answers 503 before the plugin has started', async () => {
    const res = await request(buildApp(undefined)).get('/api/containers/abc/logs/stream');

    expect(res.status).toBe(503);
  });

  it('refuses to open more streams than the ceiling allows', async () => {
    // Room overall, but this container already has its one stream.
    const limiter = new StreamLimiter({ total: 5, perTarget: 1 });
    limiter.acquire('boat/abc123def456');

    const res = await request(buildApp(new InstanceRegistry(config), { streams: limiter })).get(
      '/api/containers/abc123def456/logs/stream',
    );

    expect(res.status).toBe(429);
    expect(res.body.hint).toContain('already following this container');
    // Nothing was asked of Portainer: the refusal happens before the request.
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('frees the slot again once the stream has finished', async () => {
    const limiter = new StreamLimiter({ total: 2, perTarget: 1 });
    withEnvironment();
    boat().intercept({ path: streamPath, method: 'GET' }).reply(200, frame(1, 'one\n')).times(2);

    const app = buildApp(new InstanceRegistry(config), { streams: limiter });
    await request(app).get('/api/containers/abc123def456/logs/stream');
    const second = await request(app).get('/api/containers/abc123def456/logs/stream');

    // A stream that ended must not hold its slot, or a tab opened twice in a
    // row would be refused the second time.
    expect(second.status).toBe(200);
    expect(limiter.openCount).toBe(0);
  });
});

describe('facade log stream lifecycle', () => {
  /**
   * A log stream held open by the test rather than by Portainer, so the two
   * moments that are impossible to catch against a real server — the handshake
   * still in flight, and a stream with nothing to say — can be held still.
   */
  const heldStream = () => {
    let answer!: () => void;
    let signal: AbortSignal | undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });

    // Yields nothing: a container that is simply quiet, until the caller gives
    // up on it.
    const frames = async function* (): AsyncGenerator<LogFrame> {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    return {
      registry: {
        defaultName: 'boat',
        get: () => ({
          docker: {
            logStream: async (_id: string, abort: AbortSignal) => {
              signal = abort;
              await answered;
              return frames();
            },
          },
        }),
      } as unknown as InstanceRegistry,
      /** Lets Portainer answer the handshake. */
      answer: () => answer(),
      signal: () => signal,
    };
  };

  const serve = async (app: express.Express) => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    // Unref'd so that a test which fails before its cleanup cannot hold the
    // whole run open: jest waits for live handles, and a listening socket is
    // one. An open connection keeps its own reference while a test is running.
    server.unref();
    return {
      port: (server.address() as AddressInfo).port,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  };

  const waitFor = async (what: string, ready: () => boolean): Promise<void> => {
    for (let waited = 0; waited < 8_000; waited += 10) {
      if (ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const open = (port: number) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/containers/abc123def456/logs/stream',
    });
    // Closing a tab is not an error worth failing the test over: destroying the
    // request raises one on the client side by design.
    req.on('error', () => undefined);
    return req;
  };

  it('abandons the upstream stream when the browser leaves before Portainer answers', async () => {
    // The window in which a disconnect is easiest to miss: the request is with
    // Portainer, and nothing has been written back yet.
    const limiter = new StreamLimiter({ total: 1, perTarget: 1 });
    const held = heldStream();
    const server = await serve(buildApp(held.registry, { streams: limiter }));

    try {
      const req = open(server.port);
      await waitFor('the request to reach Portainer', () => held.signal() !== undefined);
      req.destroy();

      await waitFor('the upstream stream to be abandoned', () => held.signal()?.aborted === true);
      // Portainer answers a moment later, to nobody. Without the abort the
      // follow stream would stay open and its slot with it, and eight of those
      // refuse every log stream until Signal K restarts.
      held.answer();
      await waitFor('the stream slot to be freed', () => limiter.openCount === 0);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('keeps a quiet stream alive with comment frames', async () => {
    const held = heldStream();
    const server = await serve(buildApp(held.registry, { keepalive: 10 }));

    try {
      const req = open(server.port);
      await waitFor('the request to reach Portainer', () => held.signal() !== undefined);
      held.answer();

      const body = await new Promise<http.IncomingMessage>((resolve) => {
        req.on('response', resolve);
      });
      const received: string[] = [];
      body.setEncoding('utf8');
      body.on('data', (chunk: string) => received.push(chunk));

      // A container can say nothing for hours; the connection still has to look
      // alive to whatever proxy or NAT table sits in front of it.
      await waitFor(
        'keepalive frames',
        () =>
          received
            .join('')
            .split('\n\n')
            .filter((block) => block === ':').length >= 2,
      );

      req.destroy();
    } finally {
      await server.close();
    }
  }, 20_000);
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

  /** What Docker answers when a reference — name or id — is resolved. */
  const withInspect = (reference: string, id: string) =>
    boat()
      .intercept({
        path: `/api/endpoints/1/docker/containers/${reference}/json`,
        method: 'GET',
      })
      .reply(200, { Id: id, Name: `/${reference}`, Created: '', Image: 'img' });

  it.each([
    ['start', 'start'],
    ['stop', 'stop'],
    ['restart', 'restart'],
    ['kill', 'kill'],
    ['pause', 'pause'],
    ['unpause', 'unpause'],
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
    expect(res.body.hint).toContain('start, stop, restart, kill, pause, unpause');
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
    withInspect('ffffffffffff', 'ffffffffffff0000000000000000000000000000000000000000000000000000');
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/ffffffffffff/stop', method: 'POST' })
      .reply(204, '');

    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });
    const res = await request(app).post('/api/containers/ffffffffffff/stop');

    expect(res.status).toBe(200);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  // Docker resolves a name wherever an id goes, so a guard that only compares
  // hex ids can be walked straight past with `POST /containers/signalk/stop`.
  it('refuses a mutation that names the Signal K container instead of its id', async () => {
    withEnvironment();
    withInspect('signalk-server', SELF_ID);

    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });
    const res = await request(app).post('/api/containers/signalk-server/stop');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('running Signal K');
    // The inspect was the only call: no stop reached the proxy.
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('refuses removal that names the Signal K container', async () => {
    withEnvironment();
    withInspect('signalk_signalk_1', SELF_ID);

    const app = buildApp(new InstanceRegistry(config), {
      self: selfContainer,
      control: control({ allowDestructive: true }),
    });
    const res = await request(app).delete('/api/containers/signalk_signalk_1');

    expect(res.status).toBe(403);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('does not mutate a reference it could not resolve', async () => {
    withEnvironment();
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/ghost/json', method: 'GET' })
      .reply(404, { message: 'No such container: ghost' });

    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });
    const res = await request(app).post('/api/containers/ghost/stop');

    expect(res.status).toBe(404);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('skips the resolving inspect when self-protection cannot apply', async () => {
    withEnvironment();
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/anything/stop', method: 'POST' })
      .reply(204, '');

    // Not containerised: there is no self to protect, so no inspect is worth
    // paying for. No inspect interceptor is registered, so one would fail.
    const res = await request(buildApp(new InstanceRegistry(config))).post(
      '/api/containers/anything/stop',
    );

    expect(res.status).toBe(200);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('logs each accepted mutation with what the reference resolved to', async () => {
    withEnvironment();
    withInspect('web', 'ffffffffffff0000000000000000000000000000000000000000000000000000');
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/web/stop', method: 'POST' })
      .reply(204, '');

    const lines: string[] = [];
    const app = buildApp(new InstanceRegistry(config), {
      self: selfContainer,
      log: (message) => lines.push(message),
    });
    const res = await request(app).post('/api/containers/web/stop?instance=boat');

    expect(res.status).toBe(200);
    expect(lines).toContainEqual('container stop: web (ffffffffffff) on boat');
  });

  it('logs a refusal as well as the mutations it lets through', async () => {
    const lines: string[] = [];
    const app = buildApp(new InstanceRegistry(config), {
      self: selfContainer,
      log: (message) => lines.push(message),
    });

    await request(app).post(`/api/containers/${SELF_ID}/stop`);

    expect(lines.join('\n')).toContain('refused');
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
