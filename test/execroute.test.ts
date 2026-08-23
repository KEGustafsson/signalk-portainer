import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import type { PluginConfig } from '../src/config';
import { ConsoleSessions } from '../src/consolesessions';
import { ExecTickets } from '../src/exectickets';
import { registerRoutes } from '../src/facade';
import { InstanceRegistry } from '../src/registry';
import type { SelfContainer } from '../src/self';
import * as fixtures from './fixtures';
import { createMockAgent, restoreGlobalDispatcher } from './support';

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
  putContainers: [],
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
    consoleSessions?: ConsoleSessions;
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
            problems: [],
            telemetry: {
              level: 'off' as const,
              intervalSeconds: 30,

              pathPrefix: 'x',
            },
            control: opts.control ?? control(),
          } as PluginConfig)
        : undefined,
    self: () => opts.self ?? noSelf,
    log: opts.log ?? (() => {}),
    ...(opts.execTickets ? { execTickets: opts.execTickets } : {}),
    ...(opts.consoleSessions ? { consoleSessions: opts.consoleSessions } : {}),
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
    restoreGlobalDispatcher();
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
    // A second handle, for resizing. Distinct from the ticket, because the
    // ticket is spent by the upgrade and travels in a URL query.
    expect(res.body.session).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.session).not.toBe(res.body.ticket);
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
    expect(res.body.error).toContain('Container control is disabled');
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('blames the configuration, not the server, when control is off', async () => {
    // Tickets only exist while control is enabled, so asking about them first
    // told the operator their Signal K server was too old to serve a console —
    // for a switch they had turned off themselves, and while /api/control was
    // saying the opposite. Built without tickets on purpose: injecting them
    // here is what hid this.
    const surface = buildApp(new InstanceRegistry(config), {
      control: control({ allowPutControl: false }),
    });

    const res = await request(surface).post(`/api/containers/${CONTAINER}/exec`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Container control is disabled');
    expect(res.body.error).not.toContain('Signal K server');

    // And the control surface says the same thing about the same switch.
    const control_ = await request(surface).get('/api/control');
    expect(control_.body.console.reason).toContain('disabled in the plugin configuration');
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
      tickets.mint({
        instance: 'boat',
        execId: `exec-${index}`,
        containerId: CONTAINER,
        session: `session-${index}`,
      });

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

  describe('resizing the terminal', () => {
    const resizePath = '/api/endpoints/1/docker/exec/exec-1/resize';
    const openSession = () => {
      const sessions = new ConsoleSessions();
      sessions.add('session-1', {
        instance: 'boat',
        execId: 'exec-1',
        containerId: CONTAINER,
      });
      return sessions;
    };

    it('tells Docker how big the terminal is', async () => {
      withEnvironment();
      let asked = '';
      boat()
        .intercept({
          path: (value: string) => {
            if (!value.startsWith(resizePath)) return false;
            asked = value;
            return true;
          },
          method: 'POST',
        })
        .reply(200, '');

      const res = await request(app({ consoleSessions: openSession() }))
        .post('/api/console/resize')
        .send({ session: 'session-1', cols: 120, rows: 40 });

      expect(res.status).toBe(200);
      // Docker takes these as h and w, in that order, and getting them the
      // wrong way round produces a terminal that looks almost right.
      expect(asked).toContain('h=40');
      expect(asked).toContain('w=120');
    });

    it('answers 404 for a console that is not open', async () => {
      // The ordinary case rather than an exotic one: a dialog closing races
      // its own last resize.
      const res = await request(app({ consoleSessions: new ConsoleSessions() }))
        .post('/api/console/resize')
        .send({ session: 'session-gone', cols: 80, rows: 24 });

      expect(res.status).toBe(404);
      expect(res.body.hint).toContain('open a new one');
    });

    it('refuses a session id nobody was given', async () => {
      const res = await request(app({ consoleSessions: openSession() }))
        .post('/api/console/resize')
        .send({ session: 'session-guessed', cols: 80, rows: 24 });

      expect(res.status).toBe(404);
    });

    it('refuses a size that is not a whole number of at least one', async () => {
      const sessions = openSession();
      const send = (body: Record<string, unknown>) =>
        request(app({ consoleSessions: sessions }))
          .post('/api/console/resize')
          .send(body);

      expect((await send({ session: 'session-1', cols: 0, rows: 24 })).status).toBe(400);
      expect((await send({ session: 'session-1', cols: 80, rows: -1 })).status).toBe(400);
      expect((await send({ session: 'session-1', cols: 80.5, rows: 24 })).status).toBe(400);
      expect((await send({ session: 'session-1', cols: '80', rows: 24 })).status).toBe(400);
      expect((await send({ session: 'session-1', rows: 24 })).status).toBe(400);
      // Nothing reached Portainer: every one of those was refused here.
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('refuses a size larger than any real window', async () => {
      const res = await request(app({ consoleSessions: openSession() }))
        .post('/api/console/resize')
        .send({ session: 'session-1', cols: 100000, rows: 24 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });

    it('is refused while control is disabled', async () => {
      const res = await request(
        app({ consoleSessions: openSession(), control: control({ allowPutControl: false }) }),
      )
        .post('/api/console/resize')
        .send({ session: 'session-1', cols: 80, rows: 24 });

      expect(res.status).toBe(403);
    });

    it('answers 404 when the server cannot serve a console at all', async () => {
      // No sessions registry means no WebSocket, so there is nothing open to
      // resize and nothing to say beyond that.
      const res = await request(app())
        .post('/api/console/resize')
        .send({ session: 'session-1', cols: 80, rows: 24 });

      expect(res.status).toBe(404);
    });
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
