import type { MockAgent } from 'undici';
import plugin from '../src/index';
import type { SignalKApp } from '../src/signalk';
import * as fixtures from './fixtures';
import { createMockAgent } from './support';

const createApp = () => {
  const statuses: string[] = [];
  const errors: string[] = [];
  const debug: string[] = [];
  const app: SignalKApp = {
    debug: (message) => debug.push(message),
    error: (message) => errors.push(message),
    setPluginStatus: (message) => statuses.push(message),
    setPluginError: (message) => errors.push(message),
  };
  return { app, statuses, errors, debug };
};

const validOptions = {
  instances: [{ name: 'boat', host: 'boat.test', apiKey: 'ptr_boat' }],
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('plugin lifecycle', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('exposes the Signal K plugin contract', () => {
    const { app } = createApp();
    const instance = plugin(app);

    expect(instance.id).toBe('signalk-portainer');
    expect(instance.name).toBe('Portainer');
    expect(typeof instance.start).toBe('function');
    expect(typeof instance.stop).toBe('function');
    expect(typeof instance.registerWithRouter).toBe('function');
  });

  it('reports a configuration problem as a plugin error rather than throwing', () => {
    const { app, errors } = createApp();
    const instance = plugin(app);

    expect(() => instance.start({ instances: [] })).not.toThrow();
    expect(errors.join(' ')).toMatch(/No Portainer instance configured/);
  });

  it('starts, reports the connected version, and stops cleanly', async () => {
    const pool = agent.get('https://boat.test:9443');
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool
      .intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' })
      .reply(200, fixtures.standaloneInfo);
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);

    const { app, statuses } = createApp();
    const instance = plugin(app);

    instance.start(validOptions);
    await flush();
    await flush();

    expect(statuses.some((s) => s.includes('2.21.4'))).toBe(true);
    expect(statuses.some((s) => s.includes('local'))).toBe(true);

    instance.stop();
    expect(statuses.at(-1)).toBe('Stopped');
  });

  it('comes up even when Portainer is unreachable, and says why', async () => {
    agent
      .get('https://boat.test:9443')
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .replyWithError(new Error('connect ECONNREFUSED'));

    const { app, errors } = createApp();
    const instance = plugin(app);

    instance.start(validOptions);
    await flush();
    await flush();

    expect(errors.join(' ')).toMatch(/No Portainer instance reachable/);
    instance.stop();
  });

  it('never writes a credential to the debug log', () => {
    const { app, debug } = createApp();
    const instance = plugin(app);

    instance.start(validOptions);
    expect(debug.join(' ')).not.toContain('ptr_boat');
    instance.stop();
  });
});
