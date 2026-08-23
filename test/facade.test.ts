import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import type { PluginConfig } from '../src/config';
import { PolicyError, PortainerError } from '../src/errors';
import type { SelfContainer } from '../src/self';
import { registerRoutes, instanceParam, type FacadeHandle } from '../src/facade';
import type { LogFrame } from '../src/logframes';
import { InstanceRegistry, UnknownInstanceError } from '../src/registry';
import { StreamLimiter } from '../src/streamlimit';
import * as fixtures from './fixtures';
import { asJson, type JsonBody, createMockAgent, restoreGlobalDispatcher } from './support';

const noSelf: SelfContainer = { inContainer: false, source: 'none', identified: false };

const control = (overrides: Partial<PluginConfig['control']> = {}): PluginConfig['control'] => ({
  allowPutControl: true,
  allowDestructive: false,
  allowSelfManagement: false,
  putContainers: [],
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
    /** Receives the handle a stopping plugin would reach back through. */
    onHandle?: (handle: FacadeHandle) => void;
    saveEnvironment?: (instance: string, environmentId: number) => Promise<void>;
  } = {},
) => {
  const app = express();
  const router = express.Router();
  const handle = registerRoutes(router, {
    registry: () => registry,
    config: () =>
      registry
        ? {
            instances: [],
            problems: [],
            telemetry: {
              level: 'off' as const,
              intervalSeconds: 30,

              pathPrefix: 'x',
            },
            control: opts.control ?? control(),
          }
        : undefined,
    self: () => opts.self ?? noSelf,
    log: opts.log ?? (() => {}),
    ...(opts.streams ? { streams: opts.streams } : {}),
    ...(opts.keepalive ? { keepaliveMs: opts.keepalive } : {}),
    ...(opts.saveEnvironment ? { saveEnvironment: opts.saveEnvironment } : {}),
  });
  opts.onHandle?.(handle);
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
    restoreGlobalDispatcher();
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
    expect(asJson(res.body).error).toMatch(/not started/);
  });

  it('lists instances and marks the default, without leaking tokens', async () => {
    const registry = new InstanceRegistry(config);
    const res = await request(buildApp(registry)).get('/api/instances');

    expect(res.status).toBe(200);
    expect(asJson(res.body).instances).toHaveLength(2);
    const listed = asJson<{ instances: JsonBody[] }>(res.body).instances;
    expect(listed[0]).toMatchObject({ name: 'boat', isDefault: true });
    expect(listed[1]).toMatchObject({ name: 'shore', isDefault: false });
    expect(JSON.stringify(asJson(res.body))).not.toContain('ptr_boat');
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
    expect(asJson(res.body).ok).toBe(false);
    expect(asJson<{ instances: JsonBody[] }>(res.body).instances).toMatchObject([
      { reachable: true },
      { reachable: false },
    ]);
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
    restoreGlobalDispatcher();
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
    expect(asJson(res.body).selected).toBe(1);
    expect(asJson<{ environments: JsonBody[] }>(res.body).environments[0]).toMatchObject({
      id: 1,
      name: 'local',
      health: 'up',
      isSelected: true,
    });
  });

  it('echoes which instance served the request', async () => {
    withEnvironment(2);
    const res = await request(app()).get('/api/environments');
    expect(asJson(res.body).instance).toBe('boat');
  });

  it('routes ?instance= to that instance', async () => {
    agent
      .get('https://shore.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .times(2);

    const res = await request(app()).get('/api/environments?instance=shore');

    expect(res.status).toBe(200);
    expect(asJson(res.body).instance).toBe('shore');
  });

  it('404s on an unknown ?instance=', async () => {
    const res = await request(app()).get('/api/environments?instance=nope');

    expect(res.status).toBe(404);
    expect(asJson(res.body).error).toContain('nope');
  });

  /**
   * The picker. Before this, a Portainer with several environments and none
   * configured could only be fixed by editing the plugin configuration by
   * hand — and the route that lists the choices refused to answer, so the
   * panel could not even show what they were.
   */
  describe('choosing an environment', () => {
    const twoEnvironments = (times = 1) =>
      boat()
        .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
        .reply(200, [fixtures.localEnvironment, fixtures.nasEnvironment])
        .times(times);

    it('lists them all with no selection, rather than refusing to answer', async () => {
      twoEnvironments(2);
      const res = await request(app()).get('/api/environments');

      expect(res.status).toBe(200);
      expect(asJson(res.body).selected).toBeNull();
      expect(asJson(res.body).environments).toHaveLength(2);
      expect(
        asJson<{ environments: { isSelected: boolean }[] }>(res.body).environments.every(
          (entry) => !entry.isSelected,
        ),
      ).toBe(true);
    });

    it('selects one, and works against it afterwards', async () => {
      twoEnvironments(3);
      boat()
        .intercept({ path: '/api/endpoints/4/docker/containers/json', method: 'GET' })
        .reply(200, fixtures.containers);

      const server = app();
      const chosen = await request(server).put('/api/environment').send({ id: 4 });
      expect(chosen.status).toBe(200);
      expect(chosen.body).toMatchObject({ selected: 4, name: 'nas' });

      // The point of the whole exercise: reads now go to endpoint 4.
      const containers = await request(server).get('/api/containers');
      expect(containers.status).toBe(200);
    });

    it('refuses an environment Portainer does not have', async () => {
      twoEnvironments();
      const res = await request(app()).put('/api/environment').send({ id: 99 });

      expect(res.status).toBe(404);
      expect(asJson(res.body).error).toContain('99');
      expect(asJson(res.body).hint).toContain('4:nas');
    });

    it('refuses an id that is not a number', async () => {
      const res = await request(app()).put('/api/environment').send({ id: 'primary' });

      expect(res.status).toBe(400);
      expect(asJson(res.body).error).toContain('not a number');
    });

    it.each([[true], [null], ['2'], [1.5], [[3]]])(
      'refuses %p rather than coercing it into an environment',
      async (id) => {
        // `Number()` accepted all of these: true selected environment 1, null
        // selected 0, and "2" selected a real Docker host the caller never
        // named.
        const res = await request(app()).put('/api/environment').send({ id });

        expect(res.status).toBe(400);
        expect(asJson(res.body).error).toContain('not a number');
        // Nothing was asked of Portainer: no environment list was fetched.
        expect(agent.pendingInterceptors()).toHaveLength(0);
      },
    );

    it('saves the choice, so it outlives the process', async () => {
      twoEnvironments();
      const saved: { instance: string; id: number }[] = [];
      const server = buildApp(new InstanceRegistry(config), {
        saveEnvironment: (instance, id) => {
          saved.push({ instance, id });
          return Promise.resolve();
        },
      });

      const res = await request(server).put('/api/environment').send({ id: 4 });

      expect(asJson(res.body).persisted).toBe(true);
      expect(saved).toEqual([{ instance: 'boat', id: 4 }]);
    });

    it('still selects when the choice cannot be saved, and says so', async () => {
      // A selection that works for this session is worth more than a refusal:
      // the operator asked to look at an environment, not to edit a file.
      twoEnvironments();
      const server = buildApp(new InstanceRegistry(config), {
        saveEnvironment: () => Promise.reject(new Error('read-only config')),
      });

      const res = await request(server).put('/api/environment').send({ id: 4 });

      expect(res.status).toBe(200);
      expect(asJson(res.body).selected).toBe(4);
      expect(asJson(res.body).persisted).toBe(false);
      expect(asJson(res.body).warning).toContain('will not survive a restart');
    });

    it('is refused from another site, like every other mutation', async () => {
      const res = await request(app())
        .put('/api/environment')
        .set('origin', 'https://evil.test')
        .send({ id: 4 });

      expect(res.status).toBe(403);
    });
  });

  it('lists containers, and passes ?all= through', async () => {
    withEnvironment();
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, fixtures.containers);

    const res = await request(app()).get('/api/containers?all=true');

    expect(res.status).toBe(200);
    expect(asJson(res.body).containers).toHaveLength(2);
  });

  it('inspects a container', async () => {
    withEnvironment();
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/c1f0e2a3b4c5/json', method: 'GET' })
      .reply(200, fixtures.containerInspect);

    const res = await request(app()).get('/api/containers/c1f0e2a3b4c5');

    expect(res.status).toBe(200);
    expect(asJson<{ container: { Name: string } }>(res.body).container.Name).toBe(
      '/signalk_influxdb',
    );
  });

  it('lists stacks scoped to the environment', async () => {
    withEnvironment();
    boat().intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);

    const res = await request(app()).get('/api/stacks');

    expect(asJson<{ stacks: { Name: string }[] }>(res.body).stacks.map((s) => s.Name)).toEqual([
      'signalk',
      'from-git',
    ]);
  });

  it('serves a stack file for a stack in this environment', async () => {
    withEnvironment();
    boat().intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);
    boat()
      .intercept({ path: '/api/stacks/3/file', method: 'GET' })
      .reply(200, { StackFileContent: 'services: {}' });

    const res = await request(app()).get('/api/stacks/3/file');

    expect(res.status).toBe(200);
    expect(asJson(res.body).content).toContain('services');
  });

  it('404s a stack file belonging to another environment', async () => {
    withEnvironment();
    boat().intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);

    // Fixture stack 9 lives in EndpointId 4; this instance is bound to 1.
    const res = await request(app()).get('/api/stacks/9/file');

    expect(res.status).toBe(404);
    expect(asJson(res.body).error).toMatch(/does not belong to this environment/);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('rejects a non-numeric stack id before reaching Portainer', async () => {
    const res = await request(app()).get('/api/stacks/abc/file');

    expect(res.status).toBe(400);
    expect(asJson(res.body).error).toContain('not a number');
  });

  it.each([['0x3'], ['1e1'], ['0'], ['-2'], [' 3'], ['3.0']])(
    'rejects the stack id %p rather than reading a number out of it',
    async (id) => {
      // `Number()` reads "0x3" as 3 and "1e1" as 10, so a request naming one
      // stack acted on a different one. This route also used to accept 0 and
      // negative ids, which every other stack route refuses.
      const res = await request(app()).get(`/api/stacks/${encodeURIComponent(id)}/file`);

      expect(res.status).toBe(400);
      expect(asJson(res.body).error).toContain('not a number');
      expect(agent.pendingInterceptors()).toHaveLength(0);
    },
  );

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

    expect(asJson((await request(app()).get('/api/images')).body).images).toHaveLength(1);
    expect(asJson((await request(app()).get('/api/volumes')).body).volumes).toHaveLength(1);
    expect(asJson((await request(app()).get('/api/networks')).body).networks).toHaveLength(1);
  });
});

describe('facade swarm routes', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
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
    expect(asJson(res.body).error).toContain('not a Swarm');
    expect(asJson(res.body).hint).toContain('not an active swarm member');
  });

  it('serves services and nodes when the daemon is a swarm member', async () => {
    const pool = probe(fixtures.swarmInfo);
    pool
      .intercept({ path: '/api/endpoints/1/docker/services', method: 'GET' })
      .reply(200, [{ ID: 'svc1', Spec: { Name: 'web' } }]);

    const res = await request(buildApp(new InstanceRegistry(config))).get('/api/swarm/services');

    expect(res.status).toBe(200);
    expect(asJson(res.body).services).toHaveLength(1);
  });
});

describe('facade logs', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
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
    expect(asJson(res.body).lines).toEqual([
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

    expect(asJson(res.body).lines).toEqual([
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
    restoreGlobalDispatcher();
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
    expect(asJson(res.body).error).toContain('failed with 404');
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
    expect(asJson(res.body).hint).toContain('already following this container');
    // Nothing was asked of Portainer: the refusal happens before the request.
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  /** A follow stream that fails, either before or after the first line. */
  const failingStream = (cause: Error, opts: { afterALine?: true } = {}) => {
    // An async generator is the only shape `AsyncGenerator<LogFrame>` has, and
    // this one produces its frames from memory — there is nothing to await.
    // eslint-disable-next-line @typescript-eslint/require-await
    const frames = async function* (): AsyncGenerator<LogFrame> {
      if (opts.afterALine) yield { stream: 'stdout' as const, text: 'listening' };
      throw cause;
    };
    return {
      defaultName: 'boat',
      get: () => ({
        docker: {
          logStream: () => (opts.afterALine ? Promise.resolve(frames()) : Promise.reject(cause)),
        },
      }),
    } as unknown as InstanceRegistry;
  };

  it('answers a policy refusal with its own status rather than a 500', async () => {
    // No guard refuses a log stream today; this route's 403 would fall through
    // to 500 the moment one is added.
    const registry = failingStream(new PolicyError('Refusing to follow that', 'turn it on first'));

    const res = await request(buildApp(registry)).get('/api/containers/abc123def456/logs/stream');

    expect(res.status).toBe(403);
    expect(asJson(res.body).error).toBe('Refusing to follow that');
    expect(asJson(res.body).hint).toBe('turn it on first');
  });

  it('redacts a failure that arrives mid-stream, as it redacts the lines', async () => {
    // The data lines are redacted deliberately; the failure beside them
    // travelled verbatim, and these messages carry what Portainer said.
    const registry = failingStream(
      new PortainerError({
        status: 500,
        method: 'GET',
        path: '/logs',
        message: 'Portainer refused ptr_abcdefghijklmnopqrstuvwxyz012345',
      }),
      { afterALine: true },
    );

    const res = await request(buildApp(registry)).get('/api/containers/abc123def456/logs/stream');

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: error');
    expect(res.text).not.toContain('ptr_abcdefghijklmnopqrstuvwxyz012345');
    expect(res.text).toContain('[redacted]');
  });

  it('redacts a failure reported as a status too', async () => {
    const registry = failingStream(
      new PortainerError({
        status: 502,
        method: 'GET',
        path: '/logs',
        message: 'Portainer refused ptr_abcdefghijklmnopqrstuvwxyz012345',
      }),
    );

    const res = await request(buildApp(registry)).get('/api/containers/abc123def456/logs/stream');

    expect(res.status).toBe(502);
    expect(JSON.stringify(asJson(res.body))).not.toContain('ptr_abcdefghijklmnopqrstuvwxyz012345');
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
      // Genuinely holding the only permit there is before the browser leaves —
      // otherwise the assertions below hold just as well against a stream that
      // never started.
      expect(limiter.openCount).toBe(1);
      req.destroy();

      await waitFor('the upstream stream to be abandoned', () => held.signal()?.aborted === true);
      expect(held.signal()?.aborted).toBe(true);
      // Portainer answers a moment later, to nobody. Without the abort the
      // follow stream would stay open and its slot with it, and eight of those
      // refuse every log stream until Signal K restarts.
      held.answer();
      await waitFor('the stream slot to be freed', () => limiter.openCount === 0);
      expect(limiter.openCount).toBe(0);
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
      const comments = (): number =>
        received
          .join('')
          .split('\n\n')
          .filter((block) => block === ':').length;
      await waitFor('keepalive frames', () => comments() >= 2);

      expect(comments()).toBeGreaterThanOrEqual(2);
      // And they are comment frames, which EventSource ignores, rather than
      // events the browser would try to render.
      expect(received.join('')).toContain('event: open');

      req.destroy();
    } finally {
      await server.close();
    }
  }, 20_000);

  it('ends an open log stream when the plugin stops, giving its permit back', async () => {
    // The limiter and each request's AbortController live inside the closure
    // registerRoutes builds, and the router is registered once for the life of
    // the server. Without a handle back into it, a stream survives the plugin
    // stopping — still relaying, still holding one of eight permits — until
    // Signal K itself restarts.
    //
    // Held open by the test rather than mocked: a mocked reply that arrives and
    // ends releases the permit by itself, and the assertions below would then
    // hold against a shutdown() that did nothing at all.
    const limiter = new StreamLimiter({ total: 2, perTarget: 1 });
    const held = heldStream();
    let handle!: FacadeHandle;
    const server = await serve(
      buildApp(held.registry, { streams: limiter, onHandle: (given) => (handle = given) }),
    );

    try {
      const req = open(server.port);
      await waitFor('the request to reach Portainer', () => held.signal() !== undefined);
      held.answer();
      // Genuinely connected, genuinely holding a permit, and with nothing about
      // to end it on its own: the container is simply quiet.
      await waitFor('the stream to take its permit', () => limiter.openCount === 1);

      handle.shutdown();

      await waitFor('the permit to come back', () => limiter.openCount === 0);
      // And the upstream follow stream is abandoned, rather than left relaying
      // into a plugin that has stopped.
      expect(held.signal()?.aborted).toBe(true);
      req.destroy();
    } finally {
      await server.close();
    }
  }, 20_000);

  /**
   * A chatty container over a slow link. `res.write()` returning false is the
   * only signal that the socket cannot take more, and discarding it queued the
   * whole difference in the Node heap — unbounded, because the stream ceiling
   * counts streams and not the bytes each one holds. On a Raspberry Pi that is
   * what OOM-kills Signal K.
   */
  const chattyStream = (lines: number) => {
    const state = { produced: 0, finished: false };
    // An async generator is the only shape `AsyncGenerator<LogFrame>` has, and
    // this one produces its frames from memory — there is nothing to await.
    // eslint-disable-next-line @typescript-eslint/require-await
    const frames = async function* (): AsyncGenerator<LogFrame> {
      try {
        for (let line = 0; line < lines; line += 1) {
          state.produced += 1;
          yield { stream: 'stdout' as const, text: 'x'.repeat(16_000) };
        }
      } finally {
        state.finished = true;
      }
    };
    return {
      state,
      registry: {
        defaultName: 'boat',
        get: () => ({ docker: { logStream: () => Promise.resolve(frames()) } }),
      } as unknown as InstanceRegistry,
    };
  };

  it('stops reading the container while the browser is not reading', async () => {
    const limiter = new StreamLimiter({ total: 1, perTarget: 1 });
    const chatty = chattyStream(4_000);
    const server = await serve(buildApp(chatty.registry, { streams: limiter }));

    try {
      const req = open(server.port);
      const response = await new Promise<http.IncomingMessage>((resolve) => {
        req.on('response', resolve);
      });
      // A browser that has stopped reading: the socket fills, and nothing
      // drains it.
      response.pause();

      await waitFor('the stream to fill the socket', () => chatty.state.produced > 0);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Held to what the socket and the client's own buffer can hold — a few
      // hundred of these lines — instead of racing through all four thousand
      // and keeping the difference in the heap.
      expect(chatty.state.finished).toBe(false);
      expect(chatty.state.produced).toBeLessThan(1_000);

      // And a client that leaves mid-write ends the loop promptly rather than
      // leaving it waiting for a drain that will never come.
      req.destroy();
      await waitFor('the log stream to end', () => chatty.state.finished);
      await waitFor('the permit to come back', () => limiter.openCount === 0);
      expect(limiter.openCount).toBe(0);
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
    restoreGlobalDispatcher();
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
    expect(asJson(res.body)).toMatchObject({ action, ok: true });
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it.each([
    ['start', 'start'],
    ['stop', 'stop'],
  ])("treats Docker's 304 on %s as the success it is", async (action, dockerPath) => {
    // Docker answers 304 for a lifecycle call asking for the state a container
    // is already in. Reading that as a failure makes a second Stop look broken,
    // and makes any client that idempotently asserts a state fail on every run
    // after the first.
    withEnvironment();
    boat()
      .intercept({
        path: `/api/endpoints/1/docker/containers/abc123def456/${dockerPath}`,
        method: 'POST',
      })
      .reply(304, '');

    const res = await request(buildApp(new InstanceRegistry(config))).post(
      `/api/containers/abc123def456/${action}`,
    );

    expect(res.status).toBe(200);
    expect(asJson(res.body)).toMatchObject({ action, ok: true });
  });

  it('still reports a real Docker refusal as a failure', async () => {
    // The 304 tolerance must not swallow anything else: a 409 from Docker is
    // still an error the operator needs to see.
    withEnvironment();
    boat()
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc123def456/stop',
        method: 'POST',
      })
      .reply(409, { message: 'container is paused' });

    const res = await request(buildApp(new InstanceRegistry(config))).post(
      '/api/containers/abc123def456/stop',
    );

    expect(res.status).toBe(409);
  });

  it('rejects an unknown action before contacting Portainer', async () => {
    const res = await request(buildApp(new InstanceRegistry(config))).post(
      '/api/containers/abc123def456/destroy',
    );

    expect(res.status).toBe(400);
    expect(asJson(res.body).error).toContain('Unknown container action');
    expect(asJson(res.body).hint).toContain('start, stop, restart, kill, pause, unpause');
  });

  it('refuses every action on the container running Signal K', async () => {
    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });

    for (const action of ['start', 'stop', 'restart', 'kill']) {
      const res = await request(app).post(`/api/containers/${SELF_ID}/${action}`);
      expect(res.status).toBe(403);
      expect(asJson(res.body).error).toContain('running Signal K');
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
    const canonical = 'ffffffffffff0000000000000000000000000000000000000000000000000000';
    withEnvironment();
    withInspect('ffffffffffff', canonical);
    // The mutation goes to the id the guard resolved, not to the short
    // reference the request used: only one interceptor is registered, so a
    // second resolution by Docker would fail this test.
    boat()
      .intercept({ path: `/api/endpoints/1/docker/containers/${canonical}/stop`, method: 'POST' })
      .reply(204, '');

    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });
    const res = await request(app).post('/api/containers/ffffffffffff/stop');

    expect(res.status).toBe(200);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('acts on the id it resolved, not on the name it was given', async () => {
    // Self-protection inspects the reference to find out what it means, and
    // then used to hand Docker the raw reference anyway — a second resolution,
    // at a later moment. A container recreated under the same name in between
    // is a different container from the one the guard cleared.
    const canonical = 'ffffffffffff0000000000000000000000000000000000000000000000000000';
    withEnvironment();
    withInspect('web', canonical);
    boat()
      .intercept({ path: `/api/endpoints/1/docker/containers/${canonical}/kill`, method: 'POST' })
      .reply(204, '');

    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });
    const res = await request(app).post('/api/containers/web/kill');

    expect(res.status).toBe(200);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('removes the container it resolved, not the reference it was given', async () => {
    const canonical = 'ffffffffffff0000000000000000000000000000000000000000000000000000';
    withEnvironment();
    withInspect('web', canonical);
    boat()
      .intercept({
        path: `/api/endpoints/1/docker/containers/${canonical}?force=false&v=false`,
        method: 'DELETE',
      })
      .reply(204, '');

    const app = buildApp(new InstanceRegistry(config), {
      self: selfContainer,
      control: control({ allowDestructive: true }),
    });
    const res = await request(app).delete('/api/containers/web');

    expect(res.status).toBe(200);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('refuses a mutation when the inspect says nothing about which container it is', async () => {
    // Self-protection cannot tell a `200 {}` from "this is not Signal K", and
    // guessing is the one outcome this guard exists to prevent — so it refuses
    // rather than failing open against any proxy or agent that answers like
    // that.
    withEnvironment();
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/web/json', method: 'GET' })
      .reply(200, {});

    const app = buildApp(new InstanceRegistry(config), { self: selfContainer });
    const res = await request(app).post('/api/containers/web/stop');

    expect(res.status).toBe(403);
    expect(asJson(res.body).error).toContain('did not say which container');
    // Nothing was stopped: no interceptor for the mutation was ever needed.
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
    expect(asJson(res.body).error).toContain('running Signal K');
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
    const canonical = 'ffffffffffff0000000000000000000000000000000000000000000000000000';
    withEnvironment();
    withInspect('web', canonical);
    boat()
      .intercept({ path: `/api/endpoints/1/docker/containers/${canonical}/stop`, method: 'POST' })
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
    expect(asJson(stop.body).error).toContain('Container control is disabled');
    expect(remove.status).toBe(403);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('refuses removal unless destructive operations are enabled', async () => {
    const app = buildApp(new InstanceRegistry(config));
    const res = await request(app).delete('/api/containers/abc123def456');

    expect(res.status).toBe(403);
    expect(asJson(res.body).error).toContain('Destructive operations are disabled');
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
    expect(asJson(res.body).removeVolumes).toBe(false);
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
    expect(asJson(res.body).removeVolumes).toBe(true);
  });

  it('still refuses to remove the Signal K container even when destructive is on', async () => {
    const app = buildApp(new InstanceRegistry(config), {
      self: selfContainer,
      control: control({ allowDestructive: true }),
    });

    const res = await request(app).delete(`/api/containers/${SELF_ID}`);

    expect(res.status).toBe(403);
    expect(asJson(res.body).error).toContain('running Signal K');
  });
});

describe('facade control surface', () => {
  // Its own agent: these routes ask nothing of Portainer, but building an
  // InstanceRegistry without one leaves them on whatever dispatcher the run
  // last installed — a closed one in file order, and real DNS in isolation.
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

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
    expect(asJson(res.body)).toMatchObject({
      allowPutControl: true,
      allowDestructive: false,
      allowSelfManagement: false,
    });
    expect(asJson<{ self: JsonBody }>(res.body).self.protectionActive).toBe(true);
    expect(asJson<{ self: JsonBody }>(res.body).self.warning).toBeUndefined();
  });

  it('warns when it is containerised but cannot identify itself', async () => {
    const res = await request(
      buildApp(new InstanceRegistry(config), {
        self: { inContainer: true, source: 'none', identified: false },
      }),
    ).get('/api/control');

    expect(asJson<{ self: JsonBody }>(res.body).self.protectionActive).toBe(false);
    expect(asJson<{ self: JsonBody }>(res.body).self.warning).toContain('unable to identify');
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

    expect(asJson<{ self: JsonBody }>(res.body).self.protectionActive).toBe(false);
  });
});

describe('facade error mapping', () => {
  // Same reason as the describe above: no request leaves the process here, and
  // nothing should be left able to.
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

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
    expect(asJson(res.body).error).toContain('nope');
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
    expect(asJson(res.body).portainerStatus).toBe(404);
    expect(asJson(res.body).hint).toContain('creation-order');
  });

  it('says the hint once, rather than in the error as well', async () => {
    // PortainerError folds the hint into its message so one log line carries
    // both; sending that message beside the hint made every error the panel
    // shows say the same thing twice.
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

    expect(asJson(res.body).error).toBe('not found');
    expect(asJson(res.body).hint).toBe('ids are creation-order');
  });

  it('passes on what Portainer itself said about the failure', async () => {
    // Without it the panel can only ever show this plugin's paraphrase —
    // "failed with 400" — of something Portainer explained in words.
    const lines: string[] = [];
    const registry = failingRegistry(
      new PortainerError({
        status: 400,
        method: 'POST',
        path: '/api/stacks',
        message: 'Portainer POST /api/stacks failed with 400',
        body: '{"message":"invalid compose file: services must be a mapping"}',
      }),
    );
    const res = await request(buildApp(registry, { log: (message) => lines.push(message) })).get(
      '/api/instances',
    );

    expect(asJson(res.body).detail).toContain('services must be a mapping');
    // And in the log line, which is where an operator looks next.
    expect(lines.join('\n')).toContain('services must be a mapping');
  });

  it('redacts a refusal the way it redacts every other answer', async () => {
    // These messages interpolate upstream data — a stack name, a container
    // reference — and a refusal was the one answer that reached the browser
    // unmasked.
    const registry = failingRegistry(
      new PolicyError(
        'Refusing to delete stack ptr_abcdefghijklmnopqrstuvwxyz012345678901',
        'enable "Allow destructive operations" for ptr_abcdefghijklmnopqrstuvwxyz012345678901',
      ),
    );
    const res = await request(buildApp(registry)).get('/api/instances');

    expect(res.status).toBe(403);
    expect(JSON.stringify(asJson(res.body))).not.toContain(
      'ptr_abcdefghijklmnopqrstuvwxyz012345678901',
    );
  });

  it('maps an unexpected failure to 500', async () => {
    const res = await request(buildApp(failingRegistry(new Error('kaboom')))).get('/api/instances');

    expect(res.status).toBe(500);
    expect(asJson(res.body).error).toBe('kaboom');
  });

  it('handles a thrown non-Error', async () => {
    const res = await request(buildApp(failingRegistry('odd'))).get('/api/instances');
    expect(res.status).toBe(500);
    expect(asJson(res.body).error).toBe('odd');
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
