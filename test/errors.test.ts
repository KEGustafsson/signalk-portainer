import { PortainerError } from '../src/errors';

describe('PortainerError hints', () => {
  it('explains each status a Portainer call can fail with', () => {
    expect(PortainerError.hintFor(400, 'apiKey')).toMatch(/query parameter or body field/);
    expect(PortainerError.hintFor(403, 'apiKey')).toMatch(/role lacks permission/);
    expect(PortainerError.hintFor(404, 'apiKey')).toMatch(/creation-order/);
    expect(PortainerError.hintFor(409, 'apiKey')).toMatch(/already exists/);
    expect(PortainerError.hintFor(500, 'apiKey')).toBeUndefined();
  });

  it('gives a different 401 hint per authentication mode', () => {
    expect(PortainerError.hintFor(401, 'apiKey')).toMatch(/X-API-Key/);
    expect(PortainerError.hintFor(401, 'userPass')).toMatch(/username\/password/);
  });
});

describe('PortainerError.facadeStatus', () => {
  const build = (status: number) =>
    new PortainerError({ status, method: 'GET', path: '/x', message: 'm' });

  it('reports upstream auth failures as 502 rather than blaming the caller', () => {
    // A 401 between the plugin and Portainer is not the browser's 401.
    expect(build(401).facadeStatus).toBe(502);
    expect(build(403).facadeStatus).toBe(502);
    expect(build(0).facadeStatus).toBe(502);
  });

  it('passes other statuses through', () => {
    expect(build(404).facadeStatus).toBe(404);
    expect(build(409).facadeStatus).toBe(409);
  });
});

describe('PortainerError.fromResponse', () => {
  it('redacts and truncates the upstream body', async () => {
    const error = await PortainerError.fromResponse(
      { status: 400, text: async () => `denied ptr_${'a'.repeat(600)}` },
      'POST',
      '/api/stacks',
      'apiKey',
    );

    expect(error.body).not.toContain('ptr_a');
    expect(error.body?.length).toBeLessThanOrEqual(500);
  });

  it('survives a body that cannot be read', async () => {
    const error = await PortainerError.fromResponse(
      {
        status: 500,
        text: async () => {
          throw new Error('stream already consumed');
        },
      },
      'GET',
      '/x',
      'apiKey',
    );

    expect(error.status).toBe(500);
    expect(error.body).toBeUndefined();
  });

  it('leaves an empty body undefined rather than an empty string', async () => {
    const error = await PortainerError.fromResponse(
      { status: 404, text: async () => '' },
      'GET',
      '/x',
      'apiKey',
    );
    expect(error.body).toBeUndefined();
  });
});

describe('PortainerError.fromTransport', () => {
  it('points at connection settings for a non-timeout failure', () => {
    const error = PortainerError.fromTransport(
      new Error('connect ECONNREFUSED'),
      'GET',
      '/x',
      'https://boat:9443',
    );
    expect(error.message).toContain('check host, port and protocol');
    expect(error.status).toBe(0);
  });

  it('handles a non-Error rejection', () => {
    const error = PortainerError.fromTransport('exploded', 'GET', '/x', 'https://boat:9443');
    expect(error.message).toContain('could not be reached');
  });
});
