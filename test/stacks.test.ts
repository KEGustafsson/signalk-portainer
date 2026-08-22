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
    pool.intercept({ path: '/api/status', method: 'GET' }).reply(200, { Version: '2.21.0' });
    return pool;
  };

  const jsonBody = (body: unknown): Record<string, unknown> =>
    JSON.parse(String(body)) as Record<string, unknown>;

  it('starts and stops a stack against its own environment', async () => {
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
    pool
      .intercept({ path: '/api/stacks/3?endpointId=1&removeVolumes=false', method: 'DELETE' })
      .reply(204, '');

    const client = createClient(agent);

    await expect(client.deleteStack(3)).resolves.toBeUndefined();
  });

  it('keeps a stack’s volumes unless removal is asked for', async () => {
    const pool = withStacks();
    pool
      .intercept({ path: '/api/stacks/3?endpointId=1&removeVolumes=true', method: 'DELETE' })
      .reply(204, '');

    const client = createClient(agent);

    // The data is the point of the volume; deleting a stack says nothing about
    // wanting it gone, so it is only ever sent explicitly.
    await expect(client.deleteStack(3, { removeVolumes: true })).resolves.toBeUndefined();
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
