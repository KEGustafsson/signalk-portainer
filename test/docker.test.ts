import type { MockAgent } from 'undici';
import { PortainerError } from '../src/errors';
import * as fixtures from './fixtures';
import { BASE_URL, createClient, createMockAgent } from './support';

describe('PortainerClient docker read surface', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  /** Every docker call resolves the environment first. */
  const withEnvironment = () =>
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  it('lists running containers by default and all containers on request', async () => {
    withEnvironment();
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json', method: 'GET' })
      .reply(200, [fixtures.containers[0]]);
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, fixtures.containers);

    const client = createClient(agent);

    await expect(client.docker.listContainers()).resolves.toHaveLength(1);
    await expect(client.docker.listContainers(true)).resolves.toHaveLength(2);
  });

  it('caches the container list but not an inspect', async () => {
    withEnvironment();
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json', method: 'GET' })
      .reply(200, fixtures.containers);
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/c1f0e2a3b4c5/json', method: 'GET' })
      .reply(200, fixtures.containerInspect)
      .times(2);

    const client = createClient(agent);

    await client.docker.listContainers();
    await client.docker.listContainers();
    await client.docker.inspectContainer('c1f0e2a3b4c5');
    await client.docker.inspectContainer('c1f0e2a3b4c5');

    // One list interceptor consumed by two calls; two inspects consumed by two.
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('encodes the container id into the inspect path', async () => {
    withEnvironment();
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints/1/docker/containers/odd%2Fname/json', method: 'GET' })
      .reply(200, fixtures.containerInspect);

    const client = createClient(agent);
    await expect(client.docker.inspectContainer('odd/name')).resolves.toBeTruthy();
  });

  it('turns Docker’s null volume list into an empty array', async () => {
    withEnvironment();
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints/1/docker/volumes', method: 'GET' })
      .reply(200, fixtures.emptyVolumeList);

    const client = createClient(agent);
    await expect(client.docker.listVolumes()).resolves.toEqual([]);
  });

  it('unwraps the volume list envelope', async () => {
    withEnvironment();
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints/1/docker/volumes', method: 'GET' })
      .reply(200, fixtures.volumeList);

    const client = createClient(agent);
    const volumes = await client.docker.listVolumes();
    expect(volumes.map((v) => v.Name)).toEqual(['influxdb-data']);
  });

  it('reads images, networks and disk usage through the proxy', async () => {
    withEnvironment();
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints/1/docker/images/json', method: 'GET' })
      .reply(200, fixtures.images);
    pool
      .intercept({ path: '/api/endpoints/1/docker/networks', method: 'GET' })
      .reply(200, fixtures.networks);
    pool
      .intercept({ path: '/api/endpoints/1/docker/system/df', method: 'GET' })
      .reply(200, { LayersSize: 1234 });

    const client = createClient(agent);

    await expect(client.docker.listImages()).resolves.toHaveLength(1);
    await expect(client.docker.listNetworks()).resolves.toHaveLength(1);
    await expect(client.docker.diskUsage()).resolves.toEqual({ LayersSize: 1234 });
  });

  it('reads swarm services and nodes', async () => {
    withEnvironment();
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints/1/docker/services', method: 'GET' })
      .reply(200, [{ ID: 'svc1', Spec: { Name: 'web' } }]);
    pool
      .intercept({ path: '/api/endpoints/1/docker/nodes', method: 'GET' })
      .reply(200, [{ ID: 'node1' }]);

    const client = createClient(agent);

    await expect(client.docker.listServices()).resolves.toHaveLength(1);
    await expect(client.docker.listNodes()).resolves.toHaveLength(1);
  });

  it('maps a proxy failure to an actionable PortainerError', async () => {
    withEnvironment();
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints/1/docker/containers/json', method: 'GET' })
      .reply(403, { message: 'forbidden' });

    const client = createClient(agent);
    const error = await client.docker.listContainers().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PortainerError);
    expect((error as PortainerError).message).toMatch(/role lacks permission/);
  });
});

describe('PortainerClient stacks', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('returns only the stacks belonging to this environment', async () => {
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool.intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);

    const client = createClient(agent);
    const stacks = await client.listStacks();

    // Portainer returns every stack it knows; EndpointId 4 is a different one.
    expect(stacks.map((s) => s.Name)).toEqual(['signalk']);
  });

  /** stackFile resolves ownership first, so both calls are always needed. */
  const interceptOwnership = () => {
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool.intercept({ path: '/api/stacks', method: 'GET' }).reply(200, fixtures.stacks);
    return pool;
  };

  it('unwraps the stack file envelope', async () => {
    interceptOwnership()
      .intercept({ path: '/api/stacks/3/file', method: 'GET' })
      .reply(200, { StackFileContent: 'services:\n  influxdb:\n' });

    const client = createClient(agent);
    await expect(client.stackFile(3)).resolves.toContain('influxdb');
  });

  it('returns an empty string when Portainer omits the file content', async () => {
    interceptOwnership().intercept({ path: '/api/stacks/3/file', method: 'GET' }).reply(200, {});

    const client = createClient(agent);
    await expect(client.stackFile(3)).resolves.toBe('');
  });

  it('refuses a stack belonging to another environment', async () => {
    interceptOwnership();

    const client = createClient(agent);
    // Fixture stack 9 has EndpointId 4; this client is bound to environment 1.
    const error = await client.stackFile(9).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PortainerError);
    expect((error as PortainerError).status).toBe(404);
    expect((error as PortainerError).message).toMatch(/does not belong to this environment/);
    // The file was never requested: an unconsumed interceptor would remain.
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });
});
