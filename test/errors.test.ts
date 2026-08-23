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

  it('never answers a browser with 304, which would hide the error body', () => {
    // Docker's "already in that state" is claimed as success by the lifecycle
    // calls, so a 304 arriving here is a bug in this plugin — and a browser
    // told 304 renders its cached copy and never sees the JSON explaining it.
    expect(build(304).facadeStatus).toBe(500);
  });
});

describe('PortainerError.fromResponse', () => {
  it('redacts and truncates the upstream body', async () => {
    const error = await PortainerError.fromResponse(
      { status: 400, text: () => Promise.resolve(`denied ptr_${'a'.repeat(600)}`) },
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
        // The rejection an already-consumed body produces, which is what an
        // async function throwing was standing in for.
        text: () => Promise.reject(new Error('stream already consumed')),
      },
      'GET',
      '/x',
      'apiKey',
    );

    expect(error.status).toBe(500);
    expect(error.body).toBeUndefined();
  });

  it('puts Portainer’s own explanation in the message', async () => {
    // The status code alone leaves the operator guessing which of a dozen
    // conflicts they hit; the body is the only place that says.
    const error = await PortainerError.fromResponse(
      {
        status: 409,
        text: () =>
          Promise.resolve(JSON.stringify({ message: 'a stack with the name nav already exists' })),
      },
      'POST',
      '/api/stacks/create/standalone/string',
      'apiKey',
    );

    expect(error.message).toContain('a stack with the name nav already exists');
    // Still carried as a field: the facade surfaces it separately.
    expect(error.body).toContain('already exists');
  });

  it('adds the details field when it says something the message does not', async () => {
    const error = await PortainerError.fromResponse(
      {
        status: 500,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              message: 'Unable to deploy stack',
              details: 'yaml: line 5: did not find expected key',
            }),
          ),
      },
      'PUT',
      '/api/stacks/3',
      'apiKey',
    );

    expect(error.message).toContain(
      'Unable to deploy stack: yaml: line 5: did not find expected key',
    );
  });

  it('says the same sentence once when Portainer repeats it in both fields', async () => {
    const error = await PortainerError.fromResponse(
      {
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ message: 'invalid request', details: 'invalid request' }),
          ),
      },
      'PUT',
      '/api/stacks/3',
      'apiKey',
    );

    expect(error.message).toContain('failed with 400: invalid request —');
  });

  it('quotes nothing from a body that is not Portainer answering', async () => {
    // A reverse proxy's HTML error page, and a JSON body truncated at 500
    // characters, are both unreadable as an explanation.
    const html = await PortainerError.fromResponse(
      { status: 502, text: () => Promise.resolve('<html><body>502 Bad Gateway</body></html>') },
      'GET',
      '/api/stacks',
      'apiKey',
    );
    const truncated = await PortainerError.fromResponse(
      { status: 500, text: () => Promise.resolve('{"message":"it broke while') },
      'GET',
      '/api/stacks',
      'apiKey',
    );

    expect(html.message).toBe('Portainer GET /api/stacks failed with 502');
    expect(truncated.message).toBe('Portainer GET /api/stacks failed with 500');
  });

  it('leaves an empty body undefined rather than an empty string', async () => {
    const error = await PortainerError.fromResponse(
      { status: 404, text: () => Promise.resolve('') },
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

  /** What fetch hands back: a generic TypeError wrapping the real failure. */
  const wrapped = (cause: Error): TypeError =>
    Object.assign(new TypeError('fetch failed'), { cause });

  const coded = (code: string, message: string, name = 'Error'): Error =>
    Object.assign(new Error(message), { code, name });

  it('names the fault instead of blaming the certificate', () => {
    // Every non-timeout failure used to be answered with advice about supplying
    // a CA, which sends an operator who mistyped the host name to a setting
    // that has nothing to do with it.
    const error = PortainerError.fromTransport(
      wrapped(coded('ENOTFOUND', 'getaddrinfo ENOTFOUND portaner.local')),
      'GET',
      '/x',
      'https://portaner.local:9443',
    );

    expect(error.message).toContain('does not resolve');
    expect(error.message).not.toContain('CA');
    expect(error.message).not.toContain('rejectUnauthorized');
  });

  it.each([
    ['ECONNREFUSED', /nothing is listening/],
    ['EHOSTUNREACH', /no route to that host/],
    ['EAI_AGAIN', /DNS server/],
    ['ECONNRESET', /closed before an answer/],
  ])('explains %s in its own terms', (code, expected) => {
    const error = PortainerError.fromTransport(
      wrapped(coded(code, `connect ${code} 10.0.0.5:9443`)),
      'GET',
      '/x',
      'https://boat:9443',
    );
    expect(error.message).toMatch(expected);
  });

  it('still asks for a CA when the certificate is what failed', () => {
    const error = PortainerError.fromTransport(
      wrapped(coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate')),
      'GET',
      '/x',
      'https://boat:9443',
    );

    expect(error.message).toMatch(/supply its CA/);
  });

  it('sends a name mismatch to servername rather than to the CA', () => {
    const error = PortainerError.fromTransport(
      wrapped(
        coded('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"),
      ),
      'GET',
      '/x',
      'https://10.0.0.5:9443',
    );

    expect(error.message).toMatch(/set servername/);
  });

  it('keeps the cause, so the code and the stack survive', () => {
    // Without it the only trace of ECONNREFUSED left anywhere is the sentence
    // this class wrote, and nothing above can tell one failure from another.
    const cause = wrapped(coded('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:9443'));
    const error = PortainerError.fromTransport(cause, 'GET', '/x', 'https://boat:9443');

    expect(error.cause).toBe(cause);
  });

  it('does not call a failure a timeout because of what the host is named', () => {
    // The classification once matched the word 'timeout' anywhere in the
    // message, so every failure against this host read as a slow Portainer.
    const error = PortainerError.fromTransport(
      wrapped(coded('ENOTFOUND', 'getaddrinfo ENOTFOUND timeouts.lan')),
      'GET',
      '/x',
      'https://timeouts.lan:9443',
    );

    expect(error.message).not.toContain('before the configured timeout');
    expect(error.message).toContain('does not resolve');
  });

  it('reports a deadline and a cancellation as the different things they are', () => {
    const deadline = PortainerError.fromTransport(
      wrapped(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })),
      'GET',
      '/x',
      'https://boat:9443',
    );
    const cancelled = PortainerError.fromTransport(
      wrapped(coded('ABORT_ERR', 'This operation was aborted', 'AbortError')),
      'GET',
      '/x',
      'https://boat:9443',
    );

    expect(deadline.message).toContain('before the configured timeout');
    // A closed log stream is not a slow Portainer, and must not send the
    // operator looking for a fault that is not there.
    expect(cancelled.message).toContain('cancelled before it finished');
  });

  it('reports undici’s own read budget as a timeout', () => {
    const error = PortainerError.fromTransport(
      wrapped(coded('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error')),
      'GET',
      '/x',
      'https://boat:9443',
    );

    expect(error.message).toContain('before the configured timeout');
  });
});
