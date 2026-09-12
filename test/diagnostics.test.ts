import express from 'express';
import request from 'supertest';
import type { MockAgent } from 'undici';
import {
  PortainerClient,
  environmentSupport,
  jwtLifetimeMs,
  splitImageReference,
} from '../src/client';
import { normalizeConfig, type PluginConfig } from '../src/config';
import { registerRoutes } from '../src/facade';
import { InstanceRegistry } from '../src/registry';
import type { SelfContainer } from '../src/self';
import { EnvironmentType, type Environment } from '../src/types';
import * as fixtures from './fixtures';
import {
  asJson,
  BASE_URL,
  createClient,
  createMockAgent,
  restoreGlobalDispatcher,
} from './support';

/**
 * What the plugin learned to ask Docker and Portainer for beyond listing and
 * stopping things: what a container is costing, what is running inside it,
 * fetching an image, and recreating a container from a newer one. Plus the
 * answers it now refuses to guess at — a Kubernetes environment, a body that
 * is not JSON.
 */

const noSelf: SelfContainer = { inContainer: false, source: 'none', identified: false };

const control = (overrides: Partial<PluginConfig['control']> = {}): PluginConfig['control'] => ({
  allowPutControl: true,
  allowDestructive: false,
  allowSelfManagement: false,
  putContainers: [],
  watchdog: [],
  ...overrides,
});

const instances = normalizeConfig({
  instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }],
}).instances;

/** Where the configured instance answers, which is not the direct client's. */
const BOAT = 'https://boat.test:9443';

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
        ? {
            instances: [],
            problems: [],
            telemetry: { level: 'off' as const, intervalSeconds: 30, pathPrefix: 'x' },
            control: opts.control ?? control(),
          }
        : undefined,
    self: () => opts.self ?? noSelf,
    log: opts.log ?? (() => {}),
  });
  app.use(router);
  return app;
};

describe('reading what a container costs', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

  const withEnvironment = () =>
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  /** Docker's own arithmetic, in the shape its stats endpoint answers with. */
  const sample = {
    read: '2026-09-12T06:00:00.000000000Z',
    cpu_stats: {
      cpu_usage: { total_usage: 200_000_000 },
      system_cpu_usage: 8_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 100_000_000 },
      system_cpu_usage: 6_000_000_000,
    },
    memory_stats: {
      usage: 300_000_000,
      limit: 1_000_000_000,
      stats: { inactive_file: 50_000_000 },
    },
    networks: { eth0: { rx_bytes: 1_000, tx_bytes: 2_000 }, eth1: { rx_bytes: 5, tx_bytes: 7 } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: 4_096 },
        { op: 'Write', value: 8_192 },
        { op: 'Sync', value: 999 },
      ],
    },
    pids_stats: { current: 12 },
  };

  it('reduces a stats sample the way docker stats does', async () => {
    withEnvironment();
    agent
      .get(BASE_URL)
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc/stats?stream=false',
        method: 'GET',
      })
      .reply(200, sample);

    const stats = await createClient(agent).docker.stats('abc');

    // 100ms of container CPU against 2000ms of host CPU across 4 CPUs.
    expect(stats.cpuPercent).toBeCloseTo(20, 5);
    // The page cache is not memory the container is using, which is why
    // `docker stats` subtracts it and a raw `usage` reads high.
    expect(stats.memoryBytes).toBe(250_000_000);
    expect(stats.memoryPercent).toBeCloseTo(25, 5);
    expect(stats.networkRxBytes).toBe(1_005);
    expect(stats.networkTxBytes).toBe(2_007);
    expect(stats.blockReadBytes).toBe(4_096);
    expect(stats.blockWriteBytes).toBe(8_192);
    expect(stats.pids).toBe(12);
  });

  it('leaves out what a daemon did not report rather than reporting NaN', async () => {
    // A container that has just exited, a cgroup v1 host, a daemon with no
    // network namespace: each leaves part of this out.
    withEnvironment();
    agent
      .get(BASE_URL)
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc/stats?stream=false',
        method: 'GET',
      })
      .reply(200, { memory_stats: {}, cpu_stats: {}, precpu_stats: {} });

    const stats = await createClient(agent).docker.stats('abc');

    expect(stats).toEqual({});
  });

  it('serves the stats through the facade', async () => {
    agent
      .get(BOAT)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    agent
      .get(BOAT)
      .intercept({
        path: '/api/endpoints/1/docker/containers/abc/stats?stream=false',
        method: 'GET',
      })
      .reply(200, sample);

    const res = await request(buildApp(new InstanceRegistry(instances))).get(
      '/api/containers/abc/stats',
    );

    expect(res.status).toBe(200);
    expect(asJson<{ stats: { pids: number } }>(res.body).stats.pids).toBe(12);
  });

  it('serves the process list through the facade', async () => {
    agent
      .get(BOAT)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    agent
      .get(BOAT)
      .intercept({ path: '/api/endpoints/1/docker/containers/abc/top', method: 'GET' })
      .reply(200, { Titles: ['PID', 'CMD'], Processes: [['1', 'node']] });

    const res = await request(buildApp(new InstanceRegistry(instances))).get(
      '/api/containers/abc/top',
    );

    expect(res.status).toBe(200);
    expect(asJson<{ Processes: string[][] }>(res.body).Processes).toEqual([['1', 'node']]);
  });
});

describe('fetching an image', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

  const withEnvironment = () =>
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  it('splits a reference the way Docker takes it', () => {
    expect(splitImageReference('ais-logger')).toEqual({ name: 'ais-logger' });
    expect(splitImageReference('ais-logger:1.4')).toEqual({ name: 'ais-logger', tag: '1.4' });
    // A registry port is not a tag separator, which is the mistake a plain
    // lastIndexOf(':') makes.
    expect(splitImageReference('registry.local:5000/ais')).toEqual({
      name: 'registry.local:5000/ais',
    });
    expect(splitImageReference('registry.local:5000/ais:2')).toEqual({
      name: 'registry.local:5000/ais',
      tag: '2',
    });
    expect(splitImageReference('ais@sha256:abc')).toEqual({ name: 'ais', tag: 'sha256:abc' });
  });

  it('reads the pull to its end and reports Docker’s last word', async () => {
    withEnvironment();
    agent
      .get(BASE_URL)
      .intercept({
        path: '/api/endpoints/1/docker/images/create?fromImage=ais-logger&tag=1.4',
        method: 'POST',
      })
      .reply(
        200,
        '{"status":"Pulling from library/ais-logger"}\n{"status":"Downloaded newer image for ais-logger:1.4"}\n',
      );

    const result = await createClient(agent).docker.pullImage('ais-logger:1.4');

    expect(result.status).toBe('Downloaded newer image for ais-logger:1.4');
  });

  it('reports a failure Docker put inside the progress stream', async () => {
    // Docker answers 200 the moment it starts, so a tag that does not exist
    // arrives as an entry in the body rather than as a status.
    withEnvironment();
    agent
      .get(BASE_URL)
      .intercept({
        path: '/api/endpoints/1/docker/images/create?fromImage=ais-logger&tag=nope',
        method: 'POST',
      })
      .reply(200, '{"status":"Pulling"}\n{"errorDetail":{"message":"manifest unknown"}}\n');

    const failure = await createClient(agent)
      .docker.pullImage('ais-logger:nope')
      .catch((cause: unknown) => cause);

    expect(String(failure)).toMatch(/manifest unknown/);
  });

  it('refuses a reference that is not an image name', async () => {
    const res = await request(buildApp(new InstanceRegistry(instances)))
      .post('/api/images/pull')
      .send({ reference: '../../etc/passwd' });

    expect(res.status).toBe(400);
    expect(asJson(res.body).error).toMatch(/image name/);
  });

  it('is refused entirely while control is off', async () => {
    const res = await request(
      buildApp(new InstanceRegistry(instances), { control: control({ allowPutControl: false }) }),
    )
      .post('/api/images/pull')
      .send({ reference: 'ais-logger:1.4' });

    expect(res.status).toBe(403);
  });
});

describe('recreating a container', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

  const withEnvironment = () =>
    agent
      .get(BOAT)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);

  const destructive = () =>
    buildApp(new InstanceRegistry(instances), {
      control: control({ allowDestructive: true }),
    });

  it('asks Portainer to recreate it, and answers with the container that came back', async () => {
    withEnvironment();
    agent
      .get(BOAT)
      .intercept({ path: '/api/docker/1/containers/abc/recreate', method: 'POST' })
      .reply(200, { Id: 'def456', Name: '/ais-logger' });

    const res = await request(destructive()).post('/api/containers/abc/recreate?pullImage=true');

    expect(res.status).toBe(200);
    expect(asJson(res.body)).toMatchObject({
      action: 'recreate',
      pullImage: true,
      newId: 'def456',
    });
  });

  it('says so when Portainer is too old to offer it', async () => {
    withEnvironment();
    agent
      .get(BOAT)
      .intercept({ path: '/api/docker/1/containers/abc/recreate', method: 'POST' })
      .reply(404, { message: 'not found' });

    const res = await request(destructive()).post('/api/containers/abc/recreate');

    expect(res.status).toBe(404);
    expect(asJson(res.body).hint).toMatch(/2\.19/);
  });

  it('needs destructive, not merely control', async () => {
    const res = await request(buildApp(new InstanceRegistry(instances))).post(
      '/api/containers/abc/recreate',
    );

    expect(res.status).toBe(403);
    expect(asJson(res.body).error).toMatch(/Destructive/);
  });
});

describe('environments this plugin cannot manage', () => {
  const environment = (over: Partial<Environment>): Environment => ({
    Id: 9,
    Name: 'cluster',
    Type: EnvironmentType.LocalDocker,
    ...over,
  });

  it('accepts the Docker environments', () => {
    for (const Type of [
      EnvironmentType.LocalDocker,
      EnvironmentType.AgentOnDocker,
      EnvironmentType.EdgeAgentOnDocker,
    ]) {
      expect(environmentSupport(environment({ Type })).supported).toBe(true);
    }
  });

  it('refuses Kubernetes and Azure, which have no Docker API behind them', () => {
    for (const Type of [
      EnvironmentType.AzureACI,
      EnvironmentType.LocalKubernetes,
      EnvironmentType.AgentOnKubernetes,
      EnvironmentType.EdgeAgentOnKubernetes,
    ]) {
      expect(environmentSupport(environment({ Type })).supported).toBe(false);
    }
  });

  it('refuses an async Edge agent, which has no tunnel for the proxy', () => {
    const support = environmentSupport(
      environment({ Type: EnvironmentType.EdgeAgentOnDocker, Edge: { AsyncMode: true } }),
    );

    expect(support).toMatchObject({ supported: false });
    expect(support.supported === false && support.reason).toMatch(/async/);
  });
});

describe('a JWT’s own expiry', () => {
  const token = (payload: object): string =>
    `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

  it('is read from the claim, so a short session is renewed in time', () => {
    const now = 1_000_000;
    expect(jwtLifetimeMs(token({ exp: now / 1000 + 600 }), now)).toBe(600_000);
  });

  it('is simply absent when the token does not carry one', () => {
    expect(jwtLifetimeMs('not-a-token')).toBeUndefined();
    expect(jwtLifetimeMs(token({}))).toBeUndefined();
  });
});

describe('an answer that is not JSON', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

  it('is reported as a page answering instead of the API', async () => {
    // A captive portal, a reverse proxy's login page, or a base URL pointing
    // at Portainer's own web page: all answer 200 with HTML, and a bare
    // SyntaxError told the operator nothing about which.
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, '<!doctype html><title>Sign in</title>', {
        headers: { 'content-type': 'text/html' },
      });

    const failure = await createClient(agent)
      .listEnvironments()
      .catch((cause: unknown) => cause);

    expect(String(failure)).toMatch(/not JSON/);
    expect(String(failure)).toMatch(/check the base URL/);
  });

  it('falls back to the older status route on a Portainer that has no new one', async () => {
    agent.get(BASE_URL).intercept({ path: '/api/system/status', method: 'GET' }).reply(404, {});
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/status', method: 'GET' })
      .reply(200, { Version: '2.16.2' });

    await expect(createClient(agent).systemStatus()).resolves.toMatchObject({ Version: '2.16.2' });
  });
});

describe('a swarm worker is not a swarm manager', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

  it('reports no swarm when the node cannot see the cluster', async () => {
    // A worker reports the same active node state as a manager, and then
    // refuses every service and node call with "not a swarm manager".
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, { Swarm: { LocalNodeState: 'active' } });
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, fixtures.systemStatus);

    const client: PortainerClient = createClient(agent);

    await expect(client.capabilities()).resolves.toMatchObject({ swarm: false });
  });
});
