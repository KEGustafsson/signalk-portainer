import type { MockAgent } from 'undici';
import { PortainerError } from '../src/errors';
import * as fixtures from './fixtures';
import { BASE_URL, createClient, createMockAgent } from './support';

/** The paths of the interceptors nothing consumed, as plain strings. */
const pendingPaths = (agent: MockAgent): string[] =>
  agent.pendingInterceptors().map((interceptor) => String(interceptor.path));

describe('PortainerClient stack writes', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  /**
   * Every stack write resolves the environment and the stack list first: a
   * stack id means nothing until it is known to belong here.
   */
  const withStacks = (info = fixtures.standaloneInfo) => {
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool.intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);
    // Only a create needs it, but an unused interceptor is not an error.
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, info)
      .times(2);
    // /api/system/status, which is what the client asks for: registered under
    // the older /api/status the probe always failed and capabilities() quietly
    // swallowed it, so these tests never exercised the version at all.
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, { Version: '2.21.0' });
    return pool;
  };

  const jsonBody = (body: unknown): Record<string, unknown> =>
    JSON.parse(String(body)) as Record<string, unknown>;

  it('starts a stack against its own environment', async () => {
    const pool = withStacks();
    pool
      .intercept({ path: '/api/stacks/3/start?endpointId=1', method: 'POST' })
      .reply(200, fixtures.stacks[0]);

    const client = createClient(agent);
    await expect(client.startStack(3)).resolves.toBeUndefined();
    // endpointId is not optional in practice: without it Portainer cannot tell
    // which environment the stack belongs to and refuses the call.
    expect(pendingPaths(agent).filter((path) => path.includes('/start'))).toHaveLength(0);
  });

  it('answers a delete that carries no body at all', async () => {
    // Portainer answers a stack delete with 204 and nothing else; parsing that
    // as JSON would fail a write that in fact succeeded.
    const pool = withStacks();
    pool.intercept({ path: '/api/stacks/3?endpointId=1', method: 'DELETE' }).reply(204, '');

    const client = createClient(agent);

    await expect(client.deleteStack(3)).resolves.toBeUndefined();
  });

  it('deletes a stack without pretending to touch its volumes', async () => {
    // Portainer CE's stack delete takes no volume option — its teardown runs
    // `compose down` with no down-options — and Go ignores unknown query
    // parameters. Sending one would report a removal that never happened, so
    // the request carries nothing but the environment.
    const pool = withStacks();
    let asked = '';
    pool
      .intercept({
        path: (value: string) => {
          if (!value.startsWith('/api/stacks/3')) return false;
          asked = value;
          return true;
        },
        method: 'DELETE',
      })
      .reply(204, '');

    const client = createClient(agent);

    await expect(client.deleteStack(3)).resolves.toBeUndefined();
    expect(asked).toBe('/api/stacks/3?endpointId=1');
    expect(asked).not.toContain('removeVolumes');
  });

  it('sends the new file with prune and pull stated rather than defaulted', async () => {
    const pool = withStacks();
    let body: Record<string, unknown> = {};
    pool
      .intercept({
        path: '/api/stacks/3?endpointId=1',
        method: 'PUT',
        body: (value: string) => {
          body = jsonBody(value);
          return true;
        },
      })
      .reply(200, fixtures.stacks[0]);

    const client = createClient(agent);
    await client.updateStack(3, { content: 'services:\n  web:\n', prune: false });

    expect(body.StackFileContent).toBe('services:\n  web:\n');
    // A compose file that lost a service by accident must not take the service
    // with it, so pruning is never inherited from Portainer's default.
    expect(body.Prune).toBe(false);
    expect(body.PullImage).toBe(false);
  });

  it('keeps the environment a stack already had when none is given', async () => {
    const pool = withStacks();
    let body: Record<string, unknown> = {};
    pool
      .intercept({
        path: '/api/stacks/3?endpointId=1',
        method: 'PUT',
        body: (value: string) => {
          body = jsonBody(value);
          return true;
        },
      })
      .reply(200, fixtures.stacks[0]);

    const client = createClient(agent);
    await client.updateStack(3, { content: 'services:\n  web:\n' });

    // Sending an empty Env would silently unset every variable the stack runs
    // with — an edit to the file is not a statement about the environment.
    expect(body.Env).toEqual([{ name: 'TZ', value: 'Europe/Helsinki' }]);
  });

  it('drops an environment entry with no name rather than sending it', async () => {
    const pool = withStacks();
    let body: Record<string, unknown> = {};
    pool
      .intercept({
        path: '/api/stacks/3?endpointId=1',
        method: 'PUT',
        body: (value: string) => {
          body = jsonBody(value);
          return true;
        },
      })
      .reply(200, fixtures.stacks[0]);

    const client = createClient(agent);
    await client.updateStack(3, {
      content: 'services:\n',
      env: [
        { name: 'TZ', value: 'UTC' },
        { name: '', value: 'orphan' },
      ],
    });

    expect(body.Env).toEqual([{ name: 'TZ', value: 'UTC' }]);
  });

  it('refuses to update a stack that is deployed from a repository', async () => {
    withStacks();

    const client = createClient(agent);
    const error = await client
      .updateStack(5, { content: 'services:\n' })
      .catch((cause: unknown) => cause);

    // Portainer's update handler detaches the stack from git and clears its
    // auto-update settings. Nothing in the request says so, and the stack
    // quietly stops being what the repository describes.
    expect(error).toBeInstanceOf(PortainerError);
    expect((error as PortainerError).status).toBe(400);
    expect((error as PortainerError).hint).toMatch(/detach it from git/);
    expect(
      pendingPaths(agent).filter((path) => path === '/api/stacks/5?endpointId=1'),
    ).toHaveLength(0);
  });

  it('reports that an update took the stack’s auto-update with it', async () => {
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool
      .intercept({ path: '/api/stacks', method: 'GET' })
      .reply(200, [{ ...fixtures.stacks[0], AutoUpdate: { Webhook: 'abc-123' } }]);
    pool.intercept({ path: '/api/stacks/3?endpointId=1', method: 'PUT' }).reply(200, {});

    const client = createClient(agent);

    // Portainer discards it and the request has no field that could keep it, so
    // the only honest thing left is to say so.
    await expect(client.updateStack(3, { content: 'services:\n' })).resolves.toEqual({
      autoUpdateRemoved: true,
    });
  });

  it('says nothing about auto-update for a stack that had none', async () => {
    const pool = withStacks();
    pool.intercept({ path: '/api/stacks/3?endpointId=1', method: 'PUT' }).reply(200, {});

    const client = createClient(agent);

    await expect(client.updateStack(3, { content: 'services:\n' })).resolves.toEqual({
      autoUpdateRemoved: false,
    });
  });

  it('redeploys a git stack from the reference it was deployed from', async () => {
    const pool = withStacks();
    let body: Record<string, unknown> = {};
    pool
      .intercept({
        path: '/api/stacks/5/git/redeploy?endpointId=1',
        method: 'PUT',
        body: (value: string) => {
          body = jsonBody(value);
          return true;
        },
      })
      .reply(200, fixtures.stacks[2]);

    const client = createClient(agent);
    await client.redeployStack(5, { pullImage: true });

    expect(body.RepositoryReferenceName).toBe('refs/heads/main');
    expect(body.PullImage).toBe(true);
    expect(body.RepositoryAuthentication).toBe(false);
  });

  it('refuses to redeploy a stack that has no repository', async () => {
    withStacks();

    const client = createClient(agent);
    const error = await client.redeployStack(3).catch((cause: unknown) => cause);

    // Portainer answers this with a complaint about a field the operator never
    // filled in; saying it here gives them something to act on.
    expect(error).toBeInstanceOf(PortainerError);
    expect((error as PortainerError).status).toBe(400);
    expect((error as PortainerError).message).toMatch(/not deployed from a repository/);
    expect(pendingPaths(agent).filter((path) => path.includes('redeploy'))).toHaveLength(0);
  });

  it('refuses every write against a stack in another environment', async () => {
    const client = createClient(agent);

    for (const attempt of [
      () => {
        withStacks();
        return client.stopStack(9);
      },
      () => {
        withStacks();
        return client.updateStack(9, { content: 'services:\n' });
      },
      () => {
        withStacks();
        return client.deleteStack(9);
      },
    ]) {
      const error = await attempt().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PortainerError);
      expect((error as PortainerError).status).toBe(404);
    }
    // Nothing was ever asked of the stack itself.
    expect(pendingPaths(agent).filter((path) => path.includes('stacks/9'))).toHaveLength(0);
  });

  it('creates a standalone stack on a daemon that is not a swarm', async () => {
    const pool = withStacks();
    let body: Record<string, unknown> = {};
    pool
      .intercept({
        path: '/api/stacks/create/standalone/string?endpointId=1',
        method: 'POST',
        body: (value: string) => {
          body = jsonBody(value);
          return true;
        },
      })
      .reply(200, { Id: 11, Name: 'new', Type: 2, EndpointId: 1 });

    const client = createClient(agent);
    const created = await client.createStackFromString({
      name: 'new',
      content: 'services:\n  web:\n',
    });

    expect(created?.Id).toBe(11);
    expect(body.Name).toBe('new');
    // No SwarmID on a standalone daemon: Portainer rejects the field there.
    expect(body).not.toHaveProperty('SwarmID');
  });

  it('creates a swarm stack with the swarm id the daemon reports', async () => {
    const pool = withStacks(fixtures.swarmInfo);
    let body: Record<string, unknown> = {};
    pool
      .intercept({
        path: '/api/stacks/create/swarm/string?endpointId=1',
        method: 'POST',
        body: (value: string) => {
          body = jsonBody(value);
          return true;
        },
      })
      .reply(200, { Id: 12, Name: 'swarmed', Type: 1, EndpointId: 1 });

    const client = createClient(agent);
    await client.createStackFromString({ name: 'swarmed', content: 'services:\n' });

    expect(body.SwarmID).toBe('abc123swarmcluster');
    // The version probe really ran: an unconsumed interceptor here means the
    // capability probe failed and nobody noticed.
    await expect(client.capabilities()).resolves.toMatchObject({ portainerVersion: '2.21.0' });
    expect(pendingPaths(agent)).not.toContain('/api/system/status');
  });

  it('creates from a repository, sending credentials only when there are some', async () => {
    const pool = withStacks();
    let body: Record<string, unknown> = {};
    pool
      .intercept({
        path: '/api/stacks/create/standalone/repository?endpointId=1',
        method: 'POST',
        body: (value: string) => {
          body = jsonBody(value);
          return true;
        },
      })
      .reply(200, { Id: 13, Name: 'gitted', Type: 2, EndpointId: 1 });

    const client = createClient(agent);
    await client.createStackFromRepository({
      name: 'gitted',
      repositoryUrl: 'https://example.test/boat/stacks',
      reference: 'refs/heads/main',
      composeFile: 'boat/docker-compose.yml',
    });

    expect(body.RepositoryURL).toBe('https://example.test/boat/stacks');
    expect(body.RepositoryReferenceName).toBe('refs/heads/main');
    expect(body.ComposeFile).toBe('boat/docker-compose.yml');
    expect(body.RepositoryAuthentication).toBe(false);
    expect(body).not.toHaveProperty('RepositoryPassword');
  });

  it('gives a deploy longer to answer than a read gets', async () => {
    // Portainer answers a stack write only once compose has finished pulling
    // and starting, which is minutes for anything with an image to fetch. Held
    // to the read budget the request aborts while the deploy carries on and
    // succeeds, so the operator is told the instance is unreachable and then
    // finds the stack running.
    const pool = withStacks();
    pool
      .intercept({ path: '/api/stacks/3?endpointId=1', method: 'PUT' })
      .reply(200, fixtures.stacks[0])
      .delay(150);

    const client = createClient(agent, { timeoutMs: 50 });

    await expect(client.updateStack(3, { content: 'services:\n' })).resolves.toEqual({
      autoUpdateRemoved: false,
    });
  });

  it('still gives up on a write that outlives the write budget', async () => {
    // The budget is a bound, not an absence of one: a Portainer that accepts
    // the request and never answers must not hold the connection for ever.
    const pool = withStacks();
    pool
      .intercept({ path: '/api/stacks/3?endpointId=1', method: 'PUT' })
      .reply(200, fixtures.stacks[0])
      .delay(150);

    const client = createClient(agent, { timeoutMs: 50, writeTimeoutMs: 60 });

    await expect(client.updateStack(3, { content: 'services:\n' })).rejects.toBeInstanceOf(
      PortainerError,
    );
  });

  it('survives a create whose answer is not a stack', async () => {
    const pool = withStacks();
    pool
      .intercept({ path: '/api/stacks/create/standalone/string?endpointId=1', method: 'POST' })
      .reply(200, 'deployed');

    const client = createClient(agent);

    // The stack was created either way; there is simply nothing to report back.
    await expect(
      client.createStackFromString({ name: 'new', content: 'services:\n' }),
    ).resolves.toBeUndefined();
  });
});
