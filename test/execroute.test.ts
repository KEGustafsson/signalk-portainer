import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import type { PluginConfig } from '../src/config';
import { ExecTickets } from '../src/exectickets';
import { registerRoutes } from '../src/facade';
import { InstanceRegistry } from '../src/registry';
import type { SelfContainer } from '../src/self';
import * as fixtures from './fixtures';
import { createMockAgent } from './support';

const noSelf: SelfContainer = { inContainer: false, source: 'none', identified: false };

const SELF_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const selfContainer: SelfContainer = {
  inContainer: true,
  id: SELF_ID,
  shortId: SELF_ID.slice(0, 12),
  source: 'cgroup',
  identified: true,
};

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
    log?: (m: string) => void;
    execTickets?: ExecTickets;
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
    ...(opts.execTickets ? { execTickets: opts.execTickets } : {}),
  });
  app.use(router);
  return app;
};

const config = normalizeConfig({
  instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }],
}).instances;

describe('facade console', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const boat = () => agent.get('https://boat.test:9443');
  const withEnvironment = () =>
    boat()
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  const CONTAINER = 'c1f0e2a3b4c5d6e7f8a9b0c1';

  /** Docker's answer to the exec creation. */
  const withExec = (capture?: (body: Record<string, unknown>) => void) =>
    boat()
      .intercept({
        path: `/api/endpoints/1/docker/containers/${CONTAINER}/exec`,
        method: 'POST',
        body: (value: string) => {
          capture?.(JSON.parse(value) as Record<string, unknown>);
          return true;
        },
      })
      .reply(200, { Id: 'exec-1' });

  const app = (opts: Parameters<typeof buildApp>[1] = {}) =>
    buildApp(new InstanceRegistry(config), { execTickets: new ExecTickets(), ...opts });

  it('creates the exec instance and answers with a ticket', async () => {
    withEnvironment();
    let sent: Record<string, unknown> = {};
    withExec((value) => (sent = value));

    const res = await request(app()).post(`/api/containers/${CONTAINER}/exec`).send({});

    expect(res.status).toBe(200);
    expect(res.body.ticket).toMatch(/^[0-9a-f]{64}$/);
    // A TTY, and every stream attached: this is a terminal, not a batch run.
    expect(sent).toMatchObject({ Tty: true, AttachStdin: true, Cmd: ['/bin/sh'] });
  });

  it('runs the command the operator asked for', async () => {
    withEnvironment();
    let sent: Record<string, unknown> = {};
    withExec((value) => (sent = value));

    await request(app())
      .post(`/api/containers/${CONTAINER}/exec`)
      .send({ command: ['/bin/bash', '-l'] });

    expect(sent.Cmd).toEqual(['/bin/bash', '-l']);
  });

  it('takes a command only as a list of strings', async () => {
    // A command assembled from text and handed to a shell is how a request
    // becomes an injection; Docker takes argv, so there is no shell in between.
    for (const command of ['rm -rf /', [], ['ok', 42], ['']]) {
      const res = await request(app()).post(`/api/containers/${CONTAINER}/exec`).send({ command });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('non-empty list of strings');
    }
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('bounds how many arguments a command may have', async () => {
    const command = Array.from({ length: 40 }, (_, index) => `arg-${index}`);

    const res = await request(app()).post(`/api/containers/${CONTAINER}/exec`).send({ command });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at most 32');
  });

  it('is refused while control is disabled', async () => {
    const res = await request(app({ control: control({ allowPutControl: false }) }))
      .post(`/api/containers/${CONTAINER}/exec`)
      .send({});

    expect(res.status).toBe(403);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('refuses a shell in the Signal K container', async () => {
    // A shell there can stop Signal K as surely as the stop button can, and
    // with less to say about it afterwards.
    const res = await request(app({ self: selfContainer }))
      .post(`/api/containers/${SELF_ID}/exec`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('running Signal K');
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('is absent entirely when the server cannot serve a WebSocket', async () => {
    // No tickets means no socket to redeem one on, so the route says so
    // instead of creating an exec instance nobody can reach.
    const res = await request(buildApp(new InstanceRegistry(config)))
      .post(`/api/containers/${CONTAINER}/exec`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('not available');
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('reports the console in the control surface', async () => {
    const withConsole = await request(app()).get('/api/control');
    expect(withConsole.body.console).toEqual({ available: true });

    const without = await request(buildApp(new InstanceRegistry(config))).get('/api/control');
    expect(without.body.console.available).toBe(false);
    expect(without.body.console.reason).toContain('WebSocket');
  });

  it('logs the console being opened, with the command', async () => {
    const lines: string[] = [];
    withEnvironment();
    withExec();

    await request(app({ log: (m) => lines.push(m) }))
      .post(`/api/containers/${CONTAINER}/exec`)
      .send({ command: ['/bin/sh'] });

    expect(lines.join('\n')).toContain('console /bin/sh');
  });

  it('refuses a shell before creating one, once no ticket can be held', async () => {
    // The order is the point: creating the exec instance and then finding
    // there is no room for its ticket leaves a shell in Docker that nothing
    // can ever start, and a caller retrying accumulates them.
    withEnvironment();
    let created = false;
    withExec(() => (created = true));
    const tickets = new ExecTickets();
    for (let index = 0; index < 32; index += 1)
      tickets.mint({ instance: 'boat', execId: `exec-${index}`, containerId: CONTAINER });

    const res = await request(app({ execTickets: tickets }))
      .post(`/api/containers/${CONTAINER}/exec`)
      .send({});

    expect(res.status).toBe(429);
    expect(res.body.hint).toContain('wait a moment');
    expect(created).toBe(false);
  });

  it('gives the held place back when Docker refuses the shell', async () => {
    // Otherwise a container that is stopped would eat a place in the store on
    // every attempt, until nobody could open a console anywhere.
    withEnvironment();
    boat()
      .intercept({ path: `/api/endpoints/1/docker/containers/${CONTAINER}/exec`, method: 'POST' })
      .reply(409, { message: 'Container is not running' });
    const tickets = new ExecTickets();

    await request(app({ execTickets: tickets }))
      .post(`/api/containers/${CONTAINER}/exec`)
      .send({});

    expect(tickets.outstanding).toBe(0);
  });

  it('answers a Docker failure as a status rather than a ticket', async () => {
    withEnvironment();
    boat()
      .intercept({ path: `/api/endpoints/1/docker/containers/${CONTAINER}/exec`, method: 'POST' })
      .reply(409, { message: 'Container is not running' });

    const res = await request(app()).post(`/api/containers/${CONTAINER}/exec`).send({});

    expect(res.status).toBe(409);
    expect(res.body.ticket).toBeUndefined();
  });
});
