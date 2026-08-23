import type { MockAgent } from 'undici';
import { PortainerClient, environmentHealth } from '../src/client';
import { PortainerError } from '../src/errors';
import * as fixtures from './fixtures';
import { BASE_URL, createClient, createMockAgent } from './support';

describe('PortainerClient authentication', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('sends an API token in X-API-Key and never as a Bearer header', async () => {
    let seen: Record<string, unknown> = {};
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, (opts) => {
        seen = opts.headers as Record<string, unknown>;
        return fixtures.systemStatus;
      });

    const client = createClient(agent);
    await expect(client.systemStatus()).resolves.toEqual(fixtures.systemStatus);
    expect(seen['x-api-key']).toBe('ptr_secrettoken');
    expect(seen['authorization']).toBeUndefined();
  });

  it('exchanges username/password for a JWT and sends it as Bearer', async () => {
    const pool = agent.get(BASE_URL);
    let authCalls = 0;
    let bearer: string | undefined;

    pool.intercept({ path: '/api/auth', method: 'POST' }).reply(200, () => {
      authCalls += 1;
      return { jwt: 'eyJhbGciOiJIUzI1NiJ9.payload.signature' };
    });
    pool
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, (opts) => {
        bearer = (opts.headers as Record<string, string>)['authorization'];
        return fixtures.systemStatus;
      })
      .times(2);

    const client = createClient(agent, {
      auth: { mode: 'userPass', username: 'admin', password: 'hunter2' },
    });

    await client.systemStatus();
    await client.systemStatus();

    expect(bearer).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature');
    // Second call reuses the cached JWT.
    expect(authCalls).toBe(1);
  });

  it('authenticates once when several requests start concurrently', async () => {
    const pool = agent.get(BASE_URL);
    let authCalls = 0;

    pool.intercept({ path: '/api/auth', method: 'POST' }).reply(200, () => {
      authCalls += 1;
      return { jwt: 'eyJhbGciOiJIUzI1NiJ9.payload.signature' };
    });
    pool
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(200, fixtures.systemStatus)
      .times(3);

    const client = createClient(agent, {
      auth: { mode: 'userPass', username: 'admin', password: 'hunter2' },
    });

    await Promise.all([client.systemStatus(), client.systemStatus(), client.systemStatus()]);

    // Without in-flight coalescing this is 3.
    expect(authCalls).toBe(1);
  });

  it('renews the JWT once when Portainer answers 401, then succeeds', async () => {
    const pool = agent.get(BASE_URL);
    let authCalls = 0;

    pool
      .intercept({ path: '/api/auth', method: 'POST' })
      .reply(200, () => {
        authCalls += 1;
        return { jwt: `token-${authCalls}` };
      })
      .times(2);
    // Interceptors are consumed in registration order: the first call 401s,
    // the retry after re-authentication succeeds.
    pool
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(401, { message: 'expired' });
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);

    const client = createClient(agent, {
      auth: { mode: 'userPass', username: 'admin', password: 'hunter2' },
    });

    await expect(client.systemStatus()).resolves.toEqual(fixtures.systemStatus);
    expect(authCalls).toBe(2);
  });

  it('does not retry a rejected API key, and explains the Bearer mistake', async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/system/status', method: 'GET' })
      .reply(401, { message: 'unauthorized' });

    const client = createClient(agent);
    const error = await client.systemStatus().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PortainerError);
    expect((error as PortainerError).status).toBe(401);
    expect((error as PortainerError).message).toContain('X-API-Key');
  });
});

describe('PortainerClient environment resolution', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const interceptEnvironments = (environments: unknown[], times = 1): void => {
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, environments)
      .times(times);
  };

  it('auto-selects the only environment', async () => {
    interceptEnvironments([fixtures.localEnvironment]);
    const client = createClient(agent);
    await expect(client.environmentId()).resolves.toBe(1);
  });

  it('selects by configured id', async () => {
    interceptEnvironments([fixtures.localEnvironment, fixtures.nasEnvironment]);
    const client = createClient(agent, { environment: { id: 4 } });
    await expect(client.environmentId()).resolves.toBe(4);
  });

  it('selects by name, case-insensitively', async () => {
    interceptEnvironments([fixtures.localEnvironment, fixtures.nasEnvironment]);
    const client = createClient(agent, { environment: { name: 'NAS' } });
    await expect(client.environmentId()).resolves.toBe(4);
  });

  it('refuses to guess when several exist and none is selected', async () => {
    interceptEnvironments([fixtures.localEnvironment, fixtures.nasEnvironment]);
    const client = createClient(agent);
    const error = await client.environment().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PortainerError);
    expect((error as PortainerError).message).toContain('none is selected');
    expect((error as PortainerError).message).toContain('1:local');
    expect((error as PortainerError).message).toContain('4:nas');
  });

  it('offers the choice rather than failing when nothing is selected yet', async () => {
    // What the picker reads: the panel cannot ask the operator to choose an
    // environment if the call that lists them refuses to answer.
    interceptEnvironments([fixtures.localEnvironment, fixtures.nasEnvironment]);
    const client = createClient(agent);

    await expect(client.environmentOrNone()).resolves.toBeUndefined();
  });

  it('still reports a selection that names nothing, rather than calling it unmade', async () => {
    interceptEnvironments([fixtures.localEnvironment, fixtures.nasEnvironment]);
    const client = createClient(agent, { environment: { id: 99 } });

    await expect(client.environmentOrNone()).rejects.toThrow('99 not found');
  });

  it('works against the environment the picker chose', async () => {
    interceptEnvironments([fixtures.localEnvironment, fixtures.nasEnvironment]);
    const client = createClient(agent);
    client.selectEnvironment(4);

    await expect(client.environmentId()).resolves.toBe(4);
    expect(client.selection).toEqual({ id: 4 });
  });

  it('drops what it cached for the environment it was pointed away from', async () => {
    // The cached reads describe the previous environment's Docker daemon;
    // serving them for the new one would show the wrong host's containers.
    interceptEnvironments([fixtures.localEnvironment, fixtures.nasEnvironment]);
    const client = createClient(agent, { environment: { id: 1 } });
    await expect(client.environmentId()).resolves.toBe(1);

    client.selectEnvironment(4);
    interceptEnvironments([fixtures.localEnvironment, fixtures.nasEnvironment]);
    await expect(client.environmentId()).resolves.toBe(4);
  });

  it('says ids are creation-order when a configured id is missing', async () => {
    interceptEnvironments([fixtures.localEnvironment]);
    const client = createClient(agent, { environment: { id: 3 } });
    const error = await client.environment().catch((e: unknown) => e);

    expect((error as PortainerError).message).toContain('creation order');
  });

  it('distinguishes an empty list from a missing match', async () => {
    interceptEnvironments([]);
    const client = createClient(agent);
    const error = await client.environment().catch((e: unknown) => e);

    expect((error as PortainerError).message).toContain('no environments');
    expect((error as PortainerError).message).toContain('not authorized');
  });

  it('resolves once and caches the result', async () => {
    interceptEnvironments([fixtures.localEnvironment], 1);
    const client = createClient(agent);

    await Promise.all([client.environmentId(), client.environmentId()]);
    await client.environmentId();

    // A second uncached call would throw MockNotMatchedError.
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });
});

describe('PortainerClient capability probe', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
  });

  const interceptProbe = (info: object): void => {
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment]);
    pool.intercept({ path: '/api/endpoints/1/docker/info', method: 'GET' }).reply(200, info);
    pool.intercept({ path: '/api/system/status', method: 'GET' }).reply(200, fixtures.systemStatus);
  };

  it('reports no swarm for a standalone daemon', async () => {
    interceptProbe(fixtures.standaloneInfo);
    const client = createClient(agent);

    await expect(client.capabilities()).resolves.toEqual({
      swarm: false,
      dockerVersion: '27.3.1',
      portainerVersion: '2.21.4',
    });
  });

  it('reports the swarm cluster id when the daemon is a swarm member', async () => {
    interceptProbe(fixtures.swarmInfo);
    const client = createClient(agent);
    const capabilities = await client.capabilities();

    expect(capabilities.swarm).toBe(true);
    expect(capabilities.swarmId).toBe('abc123swarmcluster');
  });
});

describe('PortainerClient transport failures', () => {
  it('explains a self-signed certificate rather than leaking the raw error', async () => {
    const agent = createMockAgent();
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/system/status', method: 'GET' })
      .replyWithError(new Error('self-signed certificate in certificate chain'));

    const client = createClient(agent);
    const error = await client.systemStatus().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PortainerError);
    expect((error as PortainerError).status).toBe(0);
    expect((error as PortainerError).message).toContain('self-signed');
    expect((error as PortainerError).message).toContain(BASE_URL);
    await agent.close();
  });
});

describe('environmentHealth', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('uses Status for direct environments', () => {
    expect(environmentHealth(fixtures.localEnvironment, now)).toBe('up');
    expect(environmentHealth(fixtures.nasEnvironment, now)).toBe('down');
  });

  it("prefers Portainer's own heartbeat over recomputing the window", () => {
    // The check-in is far outside the window this plugin would work out on its
    // own — an async agent's is, routinely — but Portainer, which knows the
    // async intervals and stamped the check-in with its own clock, says up.
    const async = {
      ...fixtures.edgeEnvironment,
      Heartbeat: true,
      LastCheckInDate: now / 1000 - 55,
      Edge: { AsyncMode: true, PingInterval: 60, CommandInterval: 60, SnapshotInterval: 60 },
    };
    expect(environmentHealth(async, now)).toBe('up');

    // And the other way: recent enough for the local window, but Portainer has
    // stopped hearing from it.
    const silent = {
      ...fixtures.edgeEnvironment,
      Heartbeat: false,
      LastCheckInDate: now / 1000 - 1,
    };
    expect(environmentHealth(silent, now)).toBe('down');
  });

  it('uses the async intervals when Portainer publishes no heartbeat', () => {
    // EdgeCheckinInterval carries the 5s standard-mode default and must be
    // ignored: an async agent checks in on its ping interval, so 55s is fine.
    const async = {
      ...fixtures.edgeEnvironment,
      EdgeCheckinInterval: 5,
      LastCheckInDate: now / 1000 - 55,
      Edge: { AsyncMode: true, PingInterval: 60, CommandInterval: 60, SnapshotInterval: 60 },
    };
    expect(environmentHealth(async, now)).toBe('up');
    expect(environmentHealth({ ...async, LastCheckInDate: now / 1000 - 141 }, now)).toBe('down');
  });

  it('takes the shortest async interval, as Portainer does', () => {
    const async = {
      ...fixtures.edgeEnvironment,
      LastCheckInDate: now / 1000 - 41,
      Edge: { AsyncMode: true, PingInterval: 60, CommandInterval: 10, SnapshotInterval: 60 },
    };
    expect(environmentHealth(async, now)).toBe('down');
    expect(environmentHealth({ ...async, LastCheckInDate: now / 1000 - 40 }, now)).toBe('up');
  });

  it('ignores Status for edge environments and uses check-in recency', () => {
    const recent = { ...fixtures.edgeEnvironment, LastCheckInDate: now / 1000 - 30 };
    const stale = { ...fixtures.edgeEnvironment, LastCheckInDate: now / 1000 - 500 };

    expect(environmentHealth(recent, now)).toBe('up');
    // Status is 1 ("up") on both, yet the stale one must read as down.
    expect(stale.Status).toBe(1);
    expect(environmentHealth(stale, now)).toBe('down');
  });

  it('applies the 2 x interval + 20s window exactly', () => {
    const interval = 30;
    const edge = (ageSeconds: number) => ({
      ...fixtures.edgeEnvironment,
      EdgeCheckinInterval: interval,
      LastCheckInDate: now / 1000 - ageSeconds,
    });

    expect(environmentHealth(edge(80), now)).toBe('up');
    expect(environmentHealth(edge(81), now)).toBe('down');
  });

  it('treats an edge agent that never checked in as down', () => {
    expect(environmentHealth(fixtures.edgeEnvironment, now)).toBe('down');
  });

  it('falls back to a 60s interval when Portainer reports none', () => {
    const edge = {
      ...fixtures.edgeEnvironment,
      EdgeCheckinInterval: 0,
      LastCheckInDate: now / 1000 - 130,
    };
    expect(environmentHealth(edge, now)).toBe('up');
  });

  it('reports unknown when Status is absent on a direct environment', () => {
    expect(environmentHealth({ Id: 2, Name: 'x', Type: 1 }, now)).toBe('unknown');
  });
});

describe('PortainerClient transport failure classification', () => {
  it('reports a timeout as a timeout even when fetch wraps it', async () => {
    const agent = createMockAgent();
    const wrapped = new TypeError('fetch failed');
    (wrapped as { cause?: unknown }).cause = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    });
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/system/status', method: 'GET' })
      .replyWithError(wrapped);

    const client = createClient(agent);
    const error = (await client.systemStatus().catch((e: unknown) => e)) as PortainerError;

    expect(error.message).toContain('before the configured timeout');
    expect(error.message).not.toContain('self-signed');
    await agent.close();
  });
});

describe('PortainerClient TLS and lifecycle', () => {
  it('builds its own dispatcher when TLS options are supplied, and closes it', () => {
    const client = new PortainerClient({
      baseUrl: BASE_URL,
      auth: { mode: 'apiKey', apiKey: 'ptr_x' },
      tls: { rejectUnauthorized: false },
    });

    expect(() => client.close()).not.toThrow();
  });

  it('accepts a CA and a servername override', () => {
    const client = new PortainerClient({
      baseUrl: `${BASE_URL}/`,
      auth: { mode: 'apiKey', apiKey: 'ptr_x' },
      tls: { ca: 'PEM', servername: 'boatpi' },
    });

    expect(client.describeSelf().baseUrl).toBe(BASE_URL);
    client.close();
  });

  it('closing a client that owns no dispatcher is a no-op', () => {
    const client = new PortainerClient({
      baseUrl: BASE_URL,
      auth: { mode: 'apiKey', apiKey: 'ptr_x' },
    });
    expect(() => client.close()).not.toThrow();
  });

  it('drops cached reads on invalidate', async () => {
    const agent = createMockAgent();
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/endpoints?excludeSnapshots=true', method: 'GET' })
      .reply(200, [fixtures.localEnvironment])
      .times(2);

    const client = createClient(agent);
    await client.environmentId();
    client.invalidate();
    await client.environmentId();

    expect(agent.pendingInterceptors()).toHaveLength(0);
    await agent.close();
  });

  it('rejects an auth response that carries no jwt', async () => {
    const agent = createMockAgent();
    agent.get(BASE_URL).intercept({ path: '/api/auth', method: 'POST' }).reply(200, { ok: true });

    const client = createClient(agent, {
      auth: { mode: 'userPass', username: 'admin', password: 'x' },
    });
    const error = await client.systemStatus().catch((e: unknown) => e);

    expect((error as PortainerError).message).toMatch(/no jwt field/);
    await agent.close();
  });

  it('surfaces a rejected username and password', async () => {
    const agent = createMockAgent();
    agent
      .get(BASE_URL)
      .intercept({ path: '/api/auth', method: 'POST' })
      .reply(401, { message: 'invalid credentials' });

    const client = createClient(agent, {
      auth: { mode: 'userPass', username: 'admin', password: 'wrong' },
    });
    const error = await client.systemStatus().catch((e: unknown) => e);

    expect((error as PortainerError).status).toBe(401);
    expect((error as PortainerError).message).toMatch(/username\/password/);
    await agent.close();
  });
});

describe('PortainerClient introspection', () => {
  it('never exposes credentials', () => {
    const client = new PortainerClient({
      baseUrl: BASE_URL,
      auth: { mode: 'apiKey', apiKey: 'ptr_supersecret' },
    });
    expect(JSON.stringify(client.describeSelf())).not.toContain('supersecret');
  });
});
