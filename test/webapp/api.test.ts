import { ApiError, apiGet, apiSend } from '../../src/webapp/api';

describe('apiGet', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

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

  it('passes an abort signal through to fetch', async () => {
    fetchMock.mockResolvedValue(ok({}));
    const controller = new AbortController();

    await apiGet('/containers', undefined, controller.signal);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
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
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    const error = (await apiGet('/containers').catch((cause: unknown) => cause)) as ApiError;

    // Returning {} here would render an empty table, which reads as
    // "no containers" rather than "something answered instead of the plugin".
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('not JSON');
    expect(error.hint).toContain('proxy or login page');
  });

  it('surfaces the facade error and hint', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not a Swarm', hint: 'no services here' }),
    });

    const error = await apiGet('/swarm/services').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toBe('not a Swarm');
    expect((error as ApiError).hint).toBe('no services here');
  });

  it('still reports a status when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });

    const error = (await apiGet('/health').catch((cause: unknown) => cause)) as ApiError;

    expect(error.status).toBe(502);
    expect(error.message).toContain('502');
  });
});

describe('apiSend', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends the method it was given, with the session cookie', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });

    await apiSend('POST', '/containers/abc/stop', 'boat');

    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/signalk-portainer/api/containers/abc/stop?instance=boat',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('joins the instance onto a path that already has a query', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    await apiSend('DELETE', '/containers/abc?force=false&removeVolumes=true', 'shore');

    // A second '?' would make the facade ignore the instance and act on the
    // default Portainer — the wrong boat entirely.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/plugins/signalk-portainer/api/containers/abc?force=false&removeVolumes=true&instance=shore',
    );
  });

  it('surfaces a policy refusal with its hint', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Container control is disabled', hint: 'enable it' }),
    });

    const error = await apiSend('POST', '/containers/abc/stop').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).hint).toBe('enable it');
  });
});
