/**
 * The TLS settings an operator configures have to survive every hop between
 * the config form and the socket. Nothing else in the suite can see that: the
 * shared `createClient` helper injects a `dispatcher`, which takes the first
 * branch in the constructor, so no other client test reaches the code that
 * builds one from `tls` at all.
 *
 * This is the REST twin of the WebSocket test in console.test.ts, and it
 * exists because the same settings were once silently dropped there.
 */

/** Every undici Agent the client constructed, and what it asked for. */
const agents: { connect?: Record<string, unknown> }[] = [];

jest.mock('undici', () => {
  // Typed rather than left as `any`: everything spread below inherits it,
  // and the mock's own shape stops being checked against the real module.
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return {
    ...actual,
    Agent: class {
      constructor(options: { connect?: Record<string, unknown> }) {
        agents.push(options);
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

import { PortainerClient } from '../src/client';
import { normalizeConfig } from '../src/config';
import { InstanceRegistry } from '../src/registry';

const BASE_URL = 'https://portainer.test:9443';
const auth = { mode: 'apiKey' as const, apiKey: 'ptr_x' };

describe('the TLS settings reaching the connection', () => {
  beforeEach(() => {
    agents.length = 0;
  });

  it('trusts the CA the operator supplied', () => {
    // A Portainer behind a private CA is the common case on a boat, and a
    // dropped CA makes every call fail with a certificate error the operator
    // cannot act on.
    new PortainerClient({ baseUrl: BASE_URL, auth, tls: { ca: 'THE-PEM' } });

    expect(agents).toHaveLength(1);
    expect(agents[0]?.connect).toMatchObject({ ca: 'THE-PEM', rejectUnauthorized: true });
  });

  it('carries a servername override for a certificate issued to a hostname', () => {
    new PortainerClient({ baseUrl: BASE_URL, auth, tls: { servername: 'boatpi' } });

    expect(agents[0]?.connect).toMatchObject({ servername: 'boatpi' });
  });

  it('disables verification only when the configuration asks for it', () => {
    new PortainerClient({ baseUrl: BASE_URL, auth, tls: { rejectUnauthorized: false } });

    expect(agents[0]?.connect).toMatchObject({ rejectUnauthorized: false });
  });

  it('never disables verification for a client that did not ask', () => {
    // The direction that matters: silently skipping certificate checks against
    // a Portainer holding root-equivalent Docker access.
    new PortainerClient({ baseUrl: BASE_URL, auth, tls: { ca: 'THE-PEM' } });
    new PortainerClient({ baseUrl: BASE_URL, auth, tls: { servername: 'boatpi' } });

    for (const agent of agents) {
      expect(agent.connect?.rejectUnauthorized).not.toBe(false);
    }
  });

  it('carries every setting through the registry, not just into the config', () => {
    // The hop the suite never covered: config → client. Dropping `tls` here
    // leaves the config tests passing and the connection unprotected.
    const config = normalizeConfig({
      instances: [
        {
          name: 'boat',
          host: 'boat.test',
          apiKey: 'ptr_boat',
          caCert: 'BOAT-PEM',
          servername: 'boatpi',
          rejectUnauthorized: false,
        },
      ],
    }).instances;

    new InstanceRegistry(config).get('boat');

    expect(agents).toHaveLength(1);
    expect(agents[0]?.connect).toMatchObject({
      ca: 'BOAT-PEM',
      servername: 'boatpi',
      rejectUnauthorized: false,
    });
  });

  it('builds no dispatcher at all when there is nothing to configure', () => {
    // An ordinary https Portainer with a public certificate is left to
    // undici's defaults rather than handed an empty Agent.
    new PortainerClient({ baseUrl: BASE_URL, auth });

    expect(agents).toHaveLength(0);
  });
});
