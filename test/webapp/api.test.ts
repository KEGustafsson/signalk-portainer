import { ApiError, apiGet, apiSend } from '../../src/webapp/api';
import { asResponse, createFetchMock } from './mocks';

describe('apiGet', () => {
  const fetchMock = createFetchMock();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const ok = (body: unknown) =>
    asResponse({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it('calls the plugin facade and carries the Signal K session cookie', async () => {
    fetchMock.mockResolvedValue(ok({ containers: [] }));

    await apiGet('/containers');

    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/signalk-portainer/api/containers',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('appends and encodes the instance name', async () => {
    fetchMock.mockResolvedValue(ok({}));

    await apiGet('/containers', 'boat/two');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/plugins/signalk-portainer/api/containers?instance=boat%2Ftwo',
    );
  });

  it('cancels the request when the caller aborts', async () => {
    // The signal fetch is given is the caller's combined with a deadline, so
    // what matters is that the caller's abort still reaches it — not that the
    // very same object was handed over.
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('The user aborted a request.', 'AbortError')),
        );
      });
    });

    const pending = apiGet('/containers', undefined, controller.signal).catch(
      (cause: unknown) => cause,
    );
    controller.abort();
    const cause = await pending;

    // Reported as the abort it is, not dressed up as a timeout: the panel
    // replaces one read with the next every ten seconds and must not report
    // each of those as a failure.
    expect((cause as Error).name).toBe('AbortError');
  });

  it('leaves an existing query string intact', async () => {
    fetchMock.mockResolvedValue(ok({}));

    await apiGet('/containers?all=true');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/plugins/signalk-portainer/api/containers?all=true');
  });

  it('joins the instance with an ampersand when the path already has a query', async () => {
    fetchMock.mockResolvedValue(ok({}));

    await apiGet('/containers?all=true', 'shore');

    // A second '?' here would make the facade ignore the instance entirely and
    // silently serve the default one.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/plugins/signalk-portainer/api/containers?all=true&instance=shore',
    );
  });

  it('rejects a successful response that is not JSON', async () => {
    fetchMock.mockResolvedValue(
      asResponse({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      }),
    );

    const error = (await apiGet('/containers').catch((cause: unknown) => cause)) as ApiError;

    // Returning {} here would render an empty table, which reads as
    // "no containers" rather than "something answered instead of the plugin".
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('not JSON');
    expect(error.hint).toContain('proxy or login page');
  });

  it('surfaces the facade error and hint', async () => {
    fetchMock.mockResolvedValue(
      asResponse({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'not a Swarm', hint: 'no services here' }),
      }),
    );

    const error = await apiGet('/swarm/services').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toBe('not a Swarm');
    expect((error as ApiError).hint).toBe('no services here');
  });

  it('still reports a status when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      asResponse({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('not json')),
      }),
    );

    const error = (await apiGet('/health').catch((cause: unknown) => cause)) as ApiError;

    expect(error.status).toBe(502);
    expect(error.message).toContain('502');
  });
});

describe('apiSend', () => {
  const fetchMock = createFetchMock();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends the method it was given, with the session cookie', async () => {
    fetchMock.mockResolvedValue(
      asResponse({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
    );

    await apiSend('POST', '/containers/abc/stop', 'boat');

    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/signalk-portainer/api/containers/abc/stop?instance=boat',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('joins the instance onto a path that already has a query', async () => {
    fetchMock.mockResolvedValue(
      asResponse({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    );

    await apiSend('DELETE', '/containers/abc?force=false&removeVolumes=true', 'shore');

    // A second '?' would make the facade ignore the instance and act on the
    // default Portainer — the wrong boat entirely.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/plugins/signalk-portainer/api/containers/abc?force=false&removeVolumes=true&instance=shore',
    );
  });

  it('gives up on a request that never answers, rather than leaving a dead button', async () => {
    // Nothing behind a mutation heals it: reads abort their predecessor every
    // ten seconds, but a stalled POST holds the row's buttons disabled until
    // the browser's own TCP timeout — minutes — with no error and no way back.
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('The user aborted a request.', 'AbortError')),
          );
        });
      });

      const pending = apiSend('POST', '/containers/abc/stop').catch((cause: unknown) => cause);
      await jest.advanceTimersByTimeAsync(30_000);
      const error = (await pending) as ApiError;

      expect(error).toBeInstanceOf(ApiError);
      expect(error.message).toContain('timed out');
      // With something the operator can act on, rather than a bare failure.
      expect(error.hint).toContain('connection');
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up when the headers arrive and the body then stalls', async () => {
    // fetch resolves on the headers, not the body. Releasing the deadline at
    // that point left the body read unbounded, so a server that answered and
    // then stopped sending held the row disabled with no error — the very
    // failure the deadline was added to prevent.
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve(
          asResponse({
            ok: true,
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                  reject(new DOMException('The user aborted a request.', 'AbortError')),
                );
              }),
          }),
        ),
      );

      const pending = apiSend('POST', '/containers/abc/stop').catch((cause: unknown) => cause);
      await jest.advanceTimersByTimeAsync(30_000);
      const error = (await pending) as ApiError;

      expect(error).toBeInstanceOf(ApiError);
      expect(error.message).toContain('timed out');
      expect(error.hint).toContain('connection');
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves the deadline behind once the request has answered', async () => {
    // The timer is cleared in a finally: a 30 second timer left running per
    // request would keep the tab busy long after the panel was done with it.
    jest.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(
        asResponse({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
      );

      await apiSend('POST', '/containers/abc/start');

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces a policy refusal with its hint', async () => {
    fetchMock.mockResolvedValue(
      asResponse({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: 'Container control is disabled', hint: 'enable it' }),
      }),
    );

    const error = await apiSend('POST', '/containers/abc/stop').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).hint).toBe('enable it');
  });
});
