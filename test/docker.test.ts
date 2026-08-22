import type { MockAgent } from 'undici';
import { logQuery, DEFAULT_LOG_TAIL, MAX_LOG_TAIL } from '../src/client';
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

  it('drops the container list after a mutation but keeps the environment', async () => {
    // Registered once: a second /api/endpoints request has no interceptor and
    // fails the test, which is the point — a mutation must not cost one.
    withEnvironment();
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json', method: 'GET' })
      .reply(200, fixtures.containers)
      .times(2);
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/c1f0e2a3b4c5/stop', method: 'POST' })
      .reply(204, '');

    const client = createClient(agent);

    await client.docker.listContainers();
    await client.docker.stopContainer('c1f0e2a3b4c5');
    // Served from Portainer again rather than from the pre-stop snapshot.
    await client.docker.listContainers();

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
    expect(stacks.map((s) => s.Name)).toEqual(['signalk', 'from-git']);
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

describe('logQuery', () => {
  const parsed = (query: string) => Object.fromEntries(new URLSearchParams(query));

  it('always bounds the read', () => {
    // A container running for a year holds gigabytes; an unbounded read would
    // carry the whole thing through memory.
    expect(parsed(logQuery())).toMatchObject({ tail: String(DEFAULT_LOG_TAIL) });
  });

  it('clamps a tail larger than the ceiling', () => {
    expect(parsed(logQuery({ tail: 10_000_000 })).tail).toBe(String(MAX_LOG_TAIL));
  });

  it('rejects a nonsensical tail rather than sending it', () => {
    expect(parsed(logQuery({ tail: 0 })).tail).toBe(String(DEFAULT_LOG_TAIL));
    expect(parsed(logQuery({ tail: -5 })).tail).toBe('1');
    expect(parsed(logQuery({ tail: Number.NaN })).tail).toBe(String(DEFAULT_LOG_TAIL));
  });

  it('asks for both streams by default', () => {
    expect(parsed(logQuery())).toMatchObject({ stdout: 'true', stderr: 'true' });
  });

  it('still asks for something when the caller turns both off', () => {
    // Docker answers 400 for a log request that wants neither stream, which
    // would surface as a failure about a request nobody made.
    expect(parsed(logQuery({ stdout: false, stderr: false }))).toMatchObject({ stdout: 'true' });
  });

  it('carries since and timestamps only when asked', () => {
    expect(parsed(logQuery({ since: 1_700_000_000, timestamps: true }))).toMatchObject({
      since: '1700000000',
      timestamps: 'true',
    });
    expect(parsed(logQuery())).not.toHaveProperty('since');
    expect(parsed(logQuery())).not.toHaveProperty('timestamps');
  });

  it('adds follow only for a stream', () => {
    expect(parsed(logQuery({}, true))).toMatchObject({ follow: 'true' });
    expect(parsed(logQuery({}, false))).not.toHaveProperty('follow');
  });
});

describe('PortainerClient log streams', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const streamPath =
    '/api/endpoints/1/docker/containers/abc/logs?stdout=true&stderr=true&tail=200&follow=true';

  it('gives up on a handshake that never completes', async () => {
    // A follow stream has no request timeout — it is meant to stay open — but
    // opening it still has to end somewhere, or a Portainer that accepts the
    // connection and then says nothing holds the request until the process
    // restarts.
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    agent
      .get(BASE_URL)
      .intercept({ path: streamPath, method: 'GET' })
      .reply(200, Buffer.alloc(0))
      .delay(2_000);

    const client = createClient(agent, { timeoutMs: 50 });
    const forever = new AbortController();

    await expect(client.docker.logStream('abc', forever.signal)).rejects.toBeInstanceOf(
      PortainerError,
    );
  });

  it('leaves the open stream to the caller once the handshake is through', async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    agent.get(BASE_URL).intercept({ path: streamPath, method: 'GET' }).reply(200, 'plain output\n');

    // The handshake timer must not still be armed against the body: a stream
    // that outlives the timeout is the normal case, not a failure.
    const client = createClient(agent, { timeoutMs: 50 });
    const frames = await client.docker.logStream('abc', new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const collected = [];
    for await (const frame of frames) collected.push(frame);
    expect(collected).toEqual([{ stream: 'stdout', text: 'plain output\n' }]);
  });
});
