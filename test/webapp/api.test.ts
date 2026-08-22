import { ApiError, apiGet } from '../../src/webapp/api';

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

  it('leaves an existing query string intact', async () => {
    fetchMock.mockResolvedValue(ok({}));

    await apiGet('/containers?all=true');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/plugins/signalk-portainer/api/containers?all=true');
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
