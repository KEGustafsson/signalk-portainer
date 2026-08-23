import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import type { MetaValue, PathValue } from '../src/deltas';
import { DeltaPoller } from '../src/poller';
import { InstanceRegistry } from '../src/registry';
import * as fixtures from './fixtures';
import { createMockAgent } from './support';

const config = normalizeConfig({
  instances: [
    { name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' },
    { name: 'shore', host: 'shore.test', apiKey: 'ptr_shore' },
  ],
}).instances;

const boatOnly = normalizeConfig({
  instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }],
}).instances;

describe('DeltaPoller', () => {
  let agent: MockAgent;
  let published: { values: PathValue[]; meta: MetaValue[] }[];
  let logs: string[];

  beforeEach(() => {
    agent = createMockAgent();
    published = [];
    logs = [];
  });

  afterEach(async () => {
    await agent.close();
  });

  const build = (registry: InstanceRegistry | undefined, level: 'health' | 'full' = 'full') =>
    new DeltaPoller({
      registry: () => registry,
      publish: (values, meta) => published.push({ values, meta }),
      log: (message) => logs.push(message),
      intervalMs: 60_000,
      pathPrefix: 'system.docker',
      level,
    });

  /** A reachable instance with one container. */
  const interceptOk = (origin: string) => {
    const pool = agent.get(origin);
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool
      .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
      .reply(200, fixtures.containers);
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo);
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);
    return pool;
  };

  const paths = (index = 0): Record<string, unknown> =>
    Object.fromEntries((published[index]?.values ?? []).map((entry) => [entry.path, entry.value]));

  describe('a body that is not what the type says', () => {
    /** A reachable instance whose container list is something else entirely. */
    const interceptContainers = (body: object) => {
      const pool = agent.get('https://boat.test:9443');
      pool
        .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
        .reply(200, [fixtures.localEnvironment]);
      pool
        .intercept({ path: '/api/endpoints/1/docker/containers/json?all=true', method: 'GET' })
        .reply(200, body);
      pool
        .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
        .reply(200, fixtures.standaloneInfo);
      pool
        .intercept({ path: '/api/system/status', method: 'GET' })
        .reply(200, fixtures.systemStatus);
    };

    it('does not reject when a container has no id', async () => {
      // `json<T>()` casts the body without checking it, so nothing upstream
      // guarantees this shape. An unhandled rejection here ends the whole
      // Signal K process, not just the poll.
      interceptContainers([{ Names: ['/nameless'], State: 'running', Status: 'Up' }]);

      await expect(build(new InstanceRegistry(boatOnly)).poll()).resolves.toBeUndefined();
    });

    it('does not reject when the body is not a list at all', async () => {
      interceptContainers({ message: 'unauthorized' });

      await expect(build(new InstanceRegistry(boatOnly)).poll()).resolves.toBeUndefined();
    });

    it('still publishes the containers that can be keyed', async () => {
      interceptContainers([
        { Names: ['/nameless'], State: 'running', Status: 'Up' },
        { Id: 'abc123def456', Names: ['/good'], State: 'running', Status: 'Up 1 hour' },
      ]);

      await build(new InstanceRegistry(boatOnly)).poll();

      expect(paths()['system.docker.boat.containers.good.state']).toBe('running');
    });

    it('survives a publish that throws, rather than taking the server down', async () => {
      // `publish` ends in `app.handleMessage`. A throw from Signal K itself
      // must not become an unhandled rejection either.
      interceptOk('https://boat.test:9443');
      const poller = new DeltaPoller({
        registry: () => new InstanceRegistry(boatOnly),
        publish: () => {
          throw new Error('handleMessage exploded');
        },
        log: (message) => logs.push(message),
        intervalMs: 60_000,
        pathPrefix: 'system.docker',
        level: 'full',
      });

      await expect(poller.poll()).resolves.toBeUndefined();
      expect(logs.join('\n')).toContain('handleMessage exploded');
    });
  });

  it('publishes a delta for each configured instance in one message', async () => {
    interceptOk('https://boat.test:9443');
    interceptOk('https://shore.test:9443');

    await build(new InstanceRegistry(config)).poll();

    expect(published).toHaveLength(1);
    const values = paths();
    expect(values['system.docker.boat.status.reachable']).toBe(true);
    expect(values['system.docker.shore.status.reachable']).toBe(true);
  });

  it('publishes values and metadata together', async () => {
    interceptOk('https://boat.test:9443');

    await build(new InstanceRegistry(boatOnly)).poll();

    // A numeric path arriving before its units renders unlabelled for a poll.
    expect(published[0]?.meta.length).toBeGreaterThan(0);
    expect(published[0]?.values.length).toBeGreaterThan(0);
  });

  it('reports an unreachable instance as data rather than throwing', async () => {
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(500, { message: 'boom' });

    await expect(build(new InstanceRegistry(boatOnly)).poll()).resolves.toBeUndefined();

    expect(paths()['system.docker.boat.status.reachable']).toBe(false);
    expect(logs.join('\n')).toContain('poll of instance boat failed');
  });

  it('keeps polling the reachable instance when another is down', async () => {
    interceptOk('https://boat.test:9443');
    agent
      .get('https://shore.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(503, { message: 'down' });

    await build(new InstanceRegistry(config)).poll();

    const values = paths();
    expect(values['system.docker.boat.status.reachable']).toBe(true);
    expect(values['system.docker.shore.status.reachable']).toBe(false);
    expect(values['system.docker.boat.status.containersTotal']).toBe(fixtures.containers.length);
  });

  it('publishes nothing at all without a registry', async () => {
    await build(undefined).poll();
    expect(published).toHaveLength(0);
  });

  it('does not start a second poll while one is in flight', async () => {
    // One set of interceptors: a second concurrent poll would find none and the
    // instance would be reported unreachable.
    interceptOk('https://boat.test:9443');

    const poller = build(new InstanceRegistry(boatOnly));
    await Promise.all([poller.poll(), poller.poll()]);

    expect(published).toHaveLength(1);
    expect(paths()['system.docker.boat.status.reachable']).toBe(true);
  });

  it('carries the configured level through to what it publishes', async () => {
    interceptOk('https://boat.test:9443');

    await build(new InstanceRegistry(boatOnly), 'health').poll();

    const published_ = Object.keys(paths());
    expect(published_.some((path) => path.endsWith('.state'))).toBe(true);
    expect(published_.some((path) => path.endsWith('.image'))).toBe(false);
  });

  it('clears what it published when it stops', async () => {
    interceptOk('https://boat.test:9443');
    const poller = build(new InstanceRegistry(boatOnly));
    await poller.poll();

    poller.stop();

    const cleared = Object.fromEntries(
      (published[1]?.values ?? []).map((entry) => [entry.path, entry.value]),
    );
    expect(cleared['system.docker.boat.status.reachable']).toBeNull();
    expect(Object.values(cleared).every((value) => value === null)).toBe(true);
  });

  it('publishes nothing after stopping', async () => {
    interceptOk('https://boat.test:9443');
    const poller = build(new InstanceRegistry(boatOnly));

    poller.stop();
    published = [];
    await poller.poll();

    // The interceptors go unconsumed because no poll ran; agent.close() in
    // afterEach tolerates that, and the point here is the silence.
    expect(published).toHaveLength(0);
  });
});
