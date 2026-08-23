import type { MockAgent } from 'undici';
import { normalizeConfig } from '../src/config';
import { InstanceRegistry, UnknownInstanceError } from '../src/registry';
import * as fixtures from './fixtures';
import { createMockAgent, restoreGlobalDispatcher } from './support';

const instances = (extra: Record<string, unknown>[] = []) =>
  normalizeConfig({
    instances: [{ name: 'boat', host: 'boat.test', port: 9443, apiKey: 'ptr_boat' }, ...extra],
  }).instances;

describe('InstanceRegistry', () => {
  it('exposes enabled instances in configuration order', () => {
    const registry = new InstanceRegistry(
      instances([{ name: 'shore', host: 'shore.test', apiKey: 'ptr_shore' }]),
    );
    expect(registry.names).toEqual(['boat', 'shore']);
    expect(registry.defaultName).toBe('boat');
    registry.close();
  });

  it('skips disabled instances entirely', () => {
    const registry = new InstanceRegistry(
      instances([{ name: 'shore', host: 'shore.test', apiKey: 'ptr_shore', enabled: false }]),
    );
    expect(registry.names).toEqual(['boat']);
    registry.close();
  });

  it('defaults to the first instance when no name is given', () => {
    const registry = new InstanceRegistry(
      instances([{ name: 'shore', host: 'shore.test', apiKey: 'ptr_shore' }]),
    );
    expect(registry.get()).toBe(registry.get('boat'));
    registry.close();
  });

  it('invalidates every client without touching credentials or identity', () => {
    const registry = new InstanceRegistry(instances());
    expect(() => registry.invalidate()).not.toThrow();
    expect(registry.names).toEqual(['boat']);
    registry.close();
  });

  it('names the configured instances when asked for an unknown one', () => {
    const registry = new InstanceRegistry(instances());
    const error = (() => {
      try {
        registry.get('nope');
      } catch (cause) {
        return cause;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(UnknownInstanceError);
    expect((error as Error).message).toContain('boat');
    registry.close();
  });
});

describe('InstanceRegistry.health', () => {
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

  it('reports version, environment and capabilities for a reachable instance', async () => {
    interceptReachable('https://boat.test:9443');
    const registry = new InstanceRegistry(instances());

    const [health] = await registry.health();

    expect(health?.reachable).toBe(true);
    expect(health?.portainerVersion).toBe('2.21.4');
    expect(health?.environment).toEqual({ id: 1, name: 'local', type: 1, health: 'up' });
    expect(health?.capabilities?.swarm).toBe(false);
    registry.close();
  });

  it('keeps a failing instance from hiding a healthy one', async () => {
    interceptReachable('https://boat.test:9443');
    agent
      .get('https://shore.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(403, { message: 'forbidden' });

    const registry = new InstanceRegistry(
      instances([{ name: 'shore', host: 'shore.test', apiKey: 'ptr_shore' }]),
    );

    const health = await registry.health();

    expect(health.map((entry) => entry.reachable)).toEqual([true, false]);
    expect(health[1]?.error).toContain('role lacks permission');
    registry.close();
  });

  it('never puts a credential in a health report', async () => {
    interceptReachable('https://boat.test:9443');
    const registry = new InstanceRegistry(instances());

    const health = await registry.health();

    expect(JSON.stringify(health)).not.toContain('ptr_boat');
    registry.close();
  });
});
