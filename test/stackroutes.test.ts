import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import type { PluginConfig } from '../src/config';
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
  opts: { control?: PluginConfig['control']; self?: SelfContainer; log?: (m: string) => void } = {},
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
  });
  app.use(router);
  return app;
};

const config = normalizeConfig({
  instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }],
}).instances;

/** A container carrying the compose label that says which stack it is in. */
const inStack = (id: string, name: string, project: string) => ({
  Id: id,
  Names: [`/${name}`],
  Image: 'x:1',
  Created: 0,
  State: 'running',
  Status: 'Up',
  Labels: { 'com.docker.compose.project': project },
});

describe('facade stack writes', () => {
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

  const withStacks = () => {
    withEnvironment();
    boat().intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);
  };

  /** The container list a self-protection check reads. */
  const withContainers = (...containers: ReturnType<typeof inStack>[]) =>
    boat()
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, containers);

  const app = (opts: Parameters<typeof buildApp>[1] = {}) =>
    buildApp(new InstanceRegistry(config), opts);

  describe('creating a stack', () => {
    it('refuses a name that is the compose project Signal K runs under', async () => {
      // There is no stack id yet, so the id-based guard cannot help. Docker
      // keys a compose project by name: deploying this file would let Docker
      // recreate the project without Signal K in it.
      withEnvironment();
      withContainers(inStack(SELF_ID, 'signalk-server', 'signalk'));

      const res = await request(app({ self: selfContainer }))
        .post('/api/stacks')
        .send({ name: 'signalk', content: 'services: {}' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('compose project');
    });

    it('matches the project name however it was cased', async () => {
      withEnvironment();
      withContainers(inStack(SELF_ID, 'signalk-server', 'signalk'));

      const res = await request(app({ self: selfContainer }))
        .post('/api/stacks')
        .send({ name: 'SignalK', content: 'services: {}' });

      expect(res.status).toBe(403);
    });

    const withCreate = (name: string) => {
      boat()
        .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
        .reply(200, fixtures.standaloneInfo);
      boat()
        .intercept({ path: '/api/system/status', method: 'GET' })
        .reply(200, { Version: '2.21.0' });
      boat()
        .intercept({ path: '/api/stacks/create/standalone/string?endpointId=1', method: 'POST' })
        .reply(200, { Id: 11, Name: name, Type: 2, EndpointId: 1 });
    };

    it('allows an unrelated name', async () => {
      withEnvironment();
      withContainers(inStack(SELF_ID, 'signalk-server', 'signalk'));
      withCreate('weather');

      const res = await request(app({ self: selfContainer }))
        .post('/api/stacks')
        .send({ name: 'weather', content: 'services: {}' });

      expect(res.status).toBe(200);
    });

    it('allows it once self-management is on', async () => {
      withEnvironment();
      withCreate('signalk');

      const res = await request(
        app({ self: selfContainer, control: control({ allowSelfManagement: true }) }),
      )
        .post('/api/stacks')
        .send({ name: 'signalk', content: 'services: {}' });

      expect(res.status).toBe(200);
    });
  });

  describe('pruning', () => {
    it('refuses a prune on redeploy without the destructive setting', async () => {
      // A prune removes the services the new file no longer names. That is
      // destruction, and the setting that guards destruction should guard it.
      withStacks();
      withContainers();

      const res = await request(app()).post('/api/stacks/3/redeploy?prune=true');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Destructive');
    });

    it('refuses a prune on update without it either', async () => {
      withStacks();
      withContainers();

      const res = await request(app())
        .put('/api/stacks/3')
        .send({ content: 'services: {}', prune: true });

      expect(res.status).toBe(403);
    });

    it('lets a redeploy that prunes nothing past the gate', async () => {
      // The guard must not block an ordinary redeploy: this one is refused
      // later, for having no repository, which is a different answer.
      withStacks();
      withContainers();

      const res = await request(app()).post('/api/stacks/3/redeploy');

      expect(res.status).not.toBe(403);
    });
  });

  describe('lifecycle', () => {
    it('starts a stack', async () => {
      withStacks();
      boat()
        .intercept({ path: '/api/stacks/3/start?endpointId=1', method: 'POST' })
        .reply(200, fixtures.stacks[0]);

      const res = await request(app()).post('/api/stacks/3/start');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: 3, action: 'start', ok: true });
    });

    it('stops a stack', async () => {
      withStacks();
      withContainers(inStack('ffffffffffff0000', 'influx', 'signalk'));
      boat()
        .intercept({ path: '/api/stacks/3/stop?endpointId=1', method: 'POST' })
        .reply(200, fixtures.stacks[0]);

      const res = await request(app({ self: selfContainer })).post('/api/stacks/3/stop');

      expect(res.status).toBe(200);
    });

    it('refuses an action it does not have', async () => {
      const res = await request(app()).post('/api/stacks/3/destroy');

      expect(res.status).toBe(400);
      expect(res.body.hint).toContain('start, stop, redeploy');
      // Nothing was asked of Portainer.
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('refuses a stack id that is not a number', async () => {
      const res = await request(app()).post('/api/stacks/latest/stop');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not a number');
    });

    it('passes prune and pull through to a redeploy', async () => {
      withStacks();
      withContainers();
      let body: Record<string, unknown> = {};
      boat()
        .intercept({
          path: '/api/stacks/5/git/redeploy?endpointId=1',
          method: 'PUT',
          body: (value: string) => {
            body = JSON.parse(value) as Record<string, unknown>;
            return true;
          },
        })
        .reply(200, fixtures.stacks[2]);

      const res = await request(app()).post('/api/stacks/5/redeploy?pullImage=true');

      expect(res.status).toBe(200);
      expect(body.PullImage).toBe(true);
      expect(body.Prune).toBe(false);
    });
  });

  describe('update', () => {
    it('sends the compose file and reports what it did', async () => {
      withStacks();
      withContainers();
      let body: Record<string, unknown> = {};
      boat()
        .intercept({
          path: '/api/stacks/3?endpointId=1',
          method: 'PUT',
          body: (value: string) => {
            body = JSON.parse(value) as Record<string, unknown>;
            return true;
          },
        })
        .reply(200, fixtures.stacks[0]);

      const res = await request(app())
        .put('/api/stacks/3')
        .send({ content: 'services:\n  web:\n', env: [{ name: 'TZ', value: 'UTC' }] });

      expect(res.status).toBe(200);
      expect(body.StackFileContent).toBe('services:\n  web:\n');
      expect(body.Env).toEqual([{ name: 'TZ', value: 'UTC' }]);
    });

    it('refuses an update with no file in it', async () => {
      const res = await request(app()).put('/api/stacks/3').send({ env: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('content is required');
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('refuses an environment variable with no name', async () => {
      const res = await request(app())
        .put('/api/stacks/3')
        .send({ content: 'services:\n', env: [{ value: 'orphan' }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('needs a name');
    });

    it('refuses an env that is not a list', async () => {
      const res = await request(app())
        .put('/api/stacks/3')
        .send({ content: 'services:\n', env: 'TZ=UTC' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('must be a list');
    });
  });

  describe('create', () => {
    it('creates from a compose file', async () => {
      withEnvironment();
      boat()
        .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
        .reply(200, fixtures.standaloneInfo);
      boat()
        .intercept({ path: '/api/system/status', method: 'GET' })
        .reply(200, { Version: '2.21.0' });
      boat()
        .intercept({ path: '/api/stacks/create/standalone/string?endpointId=1', method: 'POST' })
        .reply(200, { Id: 11, Name: 'weather', Type: 2, EndpointId: 1 });

      const res = await request(app())
        .post('/api/stacks')
        .send({ name: 'weather', content: 'services:\n  wx:\n' });

      expect(res.status).toBe(200);
      expect(res.body.stack).toMatchObject({ Id: 11, Name: 'weather' });
      // Including the version probe, which is served at /api/system/status.
      // Registered at /api/status, it never matched: the probe threw on every
      // create and the client swallowed it, so these tests were exercising the
      // failure path without saying so.
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('creates from a repository, mapping every field the route accepts', async () => {
      withEnvironment();
      boat()
        .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
        .reply(200, fixtures.standaloneInfo);
      boat()
        .intercept({ path: '/api/system/status', method: 'GET' })
        .reply(200, { Version: '2.21.0' });
      let body: Record<string, unknown> = {};
      boat()
        .intercept({
          path: '/api/stacks/create/standalone/repository?endpointId=1',
          method: 'POST',
          body: (value: string) => {
            body = JSON.parse(value) as Record<string, unknown>;
            return true;
          },
        })
        .reply(200, { Id: 12, Name: 'weather', Type: 2, EndpointId: 1 });

      const res = await request(app()).post('/api/stacks').send({
        name: 'weather',
        repositoryUrl: 'https://example.test/boat/stacks',
        reference: 'refs/heads/main',
        composeFile: 'boat/docker-compose.yml',
        username: 'deploy',
        password: 'secret',
      });

      expect(res.status).toBe(200);
      expect(body.RepositoryURL).toBe('https://example.test/boat/stacks');
      expect(body.RepositoryReferenceName).toBe('refs/heads/main');
      expect(body.ComposeFile).toBe('boat/docker-compose.yml');
      expect(body.RepositoryAuthentication).toBe(true);
      expect(body.RepositoryUsername).toBe('deploy');
    });

    it('treats a token with no username as credentials', async () => {
      withEnvironment();
      boat()
        .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
        .reply(200, fixtures.standaloneInfo);
      boat()
        .intercept({ path: '/api/system/status', method: 'GET' })
        .reply(200, { Version: '2.21.0' });
      let body: Record<string, unknown> = {};
      boat()
        .intercept({
          path: '/api/stacks/create/standalone/repository?endpointId=1',
          method: 'POST',
          body: (value: string) => {
            body = JSON.parse(value) as Record<string, unknown>;
            return true;
          },
        })
        .reply(200, { Id: 14, Name: 'weather', Type: 2, EndpointId: 1 });

      await request(app()).post('/api/stacks').send({
        name: 'weather',
        repositoryUrl: 'https://example.test/boat/stacks',
        password: 'ghp_secret',
      });

      // Requiring both halves would clone anonymously and fail on a private
      // repository, with nothing saying why.
      expect(body.RepositoryAuthentication).toBe(true);
      expect(body.RepositoryPassword).toBe('ghp_secret');
      expect(body.RepositoryUsername).toBe('');
    });

    it('never lets a request turn off certificate verification', async () => {
      withEnvironment();
      boat()
        .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
        .reply(200, fixtures.standaloneInfo);
      boat()
        .intercept({ path: '/api/system/status', method: 'GET' })
        .reply(200, { Version: '2.21.0' });
      let body: Record<string, unknown> = {};
      boat()
        .intercept({
          path: '/api/stacks/create/standalone/repository?endpointId=1',
          method: 'POST',
          body: (value: string) => {
            body = JSON.parse(value) as Record<string, unknown>;
            return true;
          },
        })
        .reply(200, { Id: 13, Name: 'weather', Type: 2, EndpointId: 1 });

      await request(app()).post('/api/stacks').send({
        name: 'weather',
        repositoryUrl: 'https://example.test/boat/stacks',
        tlsSkipVerify: true,
      });

      // Whether a certificate is checked is the operator's configuration, not
      // a field any caller past allowPutControl gets to set per request.
      expect(body.TLSSkipVerify).toBe(false);
    });

    it('refuses a name Docker would not accept', async () => {
      const res = await request(app())
        .post('/api/stacks')
        .send({ name: '../etc', content: 'services:\n' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name is required');
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('refuses a create that names neither a file nor a repository', async () => {
      const res = await request(app()).post('/api/stacks').send({ name: 'weather' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('either a compose file or a repository');
    });

    it('refuses a create that names both', async () => {
      // Asking for both is a mistake, not a preference between them.
      const res = await request(app())
        .post('/api/stacks')
        .send({ name: 'weather', content: 'services:\n', repositoryUrl: 'https://example.test/x' });

      expect(res.status).toBe(400);
      expect(res.body.hint).toContain('not both');
    });
  });

  describe('delete', () => {
    it('is refused while destructive operations are off', async () => {
      const res = await request(app()).delete('/api/stacks/3');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Destructive operations are disabled');
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('never sends a volume option Portainer would ignore', async () => {
      // Portainer CE has no removeVolumes on stack delete. Passing one through
      // would succeed and do nothing, and the response would tell the operator
      // their data was destroyed when it was not.
      withStacks();
      withContainers();
      let asked = '';
      boat()
        .intercept({
          path: (value: string) => {
            if (!value.startsWith('/api/stacks/3?')) return false;
            asked = value;
            return true;
          },
          method: 'DELETE',
        })
        .reply(204, '');

      const res = await request(app({ control: control({ allowDestructive: true }) })).delete(
        '/api/stacks/3?removeVolumes=true',
      );

      expect(res.status).toBe(200);
      expect(asked).not.toContain('removeVolumes');
      // And the answer does not claim a removal that did not happen.
      expect(res.body.removeVolumes).toBeUndefined();
    });

    it('answers malformed JSON in the same shape as everything else', async () => {
      // Express would answer this itself, with an HTML page.
      const res = await request(app())
        .put('/api/stacks/3')
        .set('content-type', 'application/json')
        .send('{ not json');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not valid JSON');
      expect(res.body.hint).toBeTruthy();
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('answers an oversized body as JSON too, and never reads it', async () => {
      const res = await request(app())
        .put('/api/stacks/3')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ content: 'x'.repeat(600 * 1024) }));

      expect(res.status).toBe(413);
      expect(res.body.error).toContain('larger than 512kb');
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });
  });

  describe('audit', () => {
    it('calls a stack a stack', async () => {
      const lines: string[] = [];
      withStacks();
      boat()
        .intercept({ path: '/api/stacks/3/start?endpointId=1', method: 'POST' })
        .reply(200, fixtures.stacks[0]);

      await request(app({ log: (m) => lines.push(m) })).post('/api/stacks/3/start');

      // "container start" would be the wrong noun for a stack.
      expect(lines).toContain('stack start: 3 on default instance');
    });
  });

  describe('a stack that lives in git', () => {
    it('is not updated through the file route', async () => {
      withStacks();
      withContainers();

      const res = await request(app())
        .put('/api/stacks/5')
        .send({ content: 'services:\n  web:\n' });

      expect(res.status).toBe(400);
      expect(res.body.hint).toContain('detach it from git');
    });

    it('is redeployed instead', async () => {
      withStacks();
      withContainers();
      boat()
        .intercept({ path: '/api/stacks/5/git/redeploy?endpointId=1', method: 'PUT' })
        .reply(200, fixtures.stacks[2]);

      const res = await request(app()).post('/api/stacks/5/redeploy');

      expect(res.status).toBe(200);
    });
  });

  describe('guards', () => {
    it('refuses every write while control is disabled', async () => {
      const off = app({ control: control({ allowPutControl: false }) });

      for (const send of [
        () => request(off).post('/api/stacks/3/stop'),
        () => request(off).put('/api/stacks/3').send({ content: 'services:\n' }),
        () => request(off).post('/api/stacks').send({ name: 'x', content: 'services:\n' }),
        () => request(off).delete('/api/stacks/3'),
      ]) {
        const res = await send();
        expect(res.status).toBe(403);
      }
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('refuses to stop the stack the Signal K container is in', async () => {
      // The container guard catches "stop this container"; this catches the
      // same outcome reached by naming the stack around it.
      withStacks();
      withContainers(inStack(SELF_ID, 'signalk-server', 'signalk'));

      const res = await request(app({ self: selfContainer })).post('/api/stacks/3/stop');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('contains the container running Signal K');
    });

    it('refuses to update or delete that stack too', async () => {
      for (const send of [
        async () => {
          withStacks();
          withContainers(inStack(SELF_ID, 'signalk-server', 'signalk'));
          return request(app({ self: selfContainer }))
            .put('/api/stacks/3')
            .send({ content: 'services:\n' });
        },
        async () => {
          withStacks();
          withContainers(inStack(SELF_ID, 'signalk-server', 'signalk'));
          return request(
            app({ self: selfContainer, control: control({ allowDestructive: true }) }),
          ).delete('/api/stacks/3');
        },
      ]) {
        const res = await send();
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('running Signal K');
      }
    });

    it('still starts that stack, which cannot take Signal K down', async () => {
      withStacks();
      boat()
        .intercept({ path: '/api/stacks/3/start?endpointId=1', method: 'POST' })
        .reply(200, fixtures.stacks[0]);

      const res = await request(app({ self: selfContainer })).post('/api/stacks/3/start');

      expect(res.status).toBe(200);
    });

    it('allows the stack write once self-management is enabled', async () => {
      withStacks();
      boat()
        .intercept({ path: '/api/stacks/3/stop?endpointId=1', method: 'POST' })
        .reply(200, fixtures.stacks[0]);

      const res = await request(
        app({ self: selfContainer, control: control({ allowSelfManagement: true }) }),
      ).post('/api/stacks/3/stop');

      expect(res.status).toBe(200);
      // The container list is never read: the guard is off, not just passed.
      expect(agent.pendingInterceptors()).toHaveLength(0);
    });

    it('leaves a stack alone that Signal K is not in', async () => {
      withStacks();
      withContainers(inStack(SELF_ID, 'signalk-server', 'infrastructure'));
      boat()
        .intercept({ path: '/api/stacks/3/stop?endpointId=1', method: 'POST' })
        .reply(200, fixtures.stacks[0]);

      const res = await request(app({ self: selfContainer })).post('/api/stacks/3/stop');

      expect(res.status).toBe(200);
    });

    it('logs a refusal as well as an accepted write', async () => {
      const lines: string[] = [];
      withStacks();
      withContainers(inStack(SELF_ID, 'signalk-server', 'signalk'));

      await request(app({ self: selfContainer, log: (m) => lines.push(m) })).post(
        '/api/stacks/3/stop',
      );

      expect(lines.join('\n')).toContain('refused');
    });
  });
});
