import { fetch as undiciFetch, type MockAgent } from 'undici';
import {
  BASE_URL,
  createMockAgent,
  expectAllConsumed,
  expectNotRequested,
  restoreGlobalDispatcher,
} from './support';

/**
 * The two helpers the rest of the suite leans on to say "this request was
 * made" and "this one was not".
 *
 * Covered here because they exist to stop an assertion from being empty, and
 * an empty assertion is exactly the kind of thing that goes unnoticed: the
 * shape they replace — filtering the pending set for a path and expecting
 * nothing — passed for years in tests that had registered nothing at all.
 * Each helper is pinned in both directions, so a change that made it stop
 * failing would be caught here rather than quietly weaken every test that
 * calls it.
 */
describe('mock agent assertions', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = createMockAgent();
  });

  afterEach(async () => {
    await agent.close();
    restoreGlobalDispatcher();
  });

  const register = (path: string, method = 'GET'): void => {
    agent.get(BASE_URL).intercept({ path, method }).reply(200, {});
  };

  const request = async (path: string): Promise<void> => {
    await undiciFetch(`${BASE_URL}${path}`, { dispatcher: agent });
  };

  describe('expectAllConsumed', () => {
    it('refuses a test that registered nothing', () => {
      // The whole point: `pendingInterceptors()` is empty here, and on its own
      // would read as "every request was one this test expected".
      expect(() => {
        expectAllConsumed(agent);
      }).toThrow();
    });

    it('refuses a request that was expected and never made', () => {
      register('/api/x');

      expect(() => {
        expectAllConsumed(agent);
      }).toThrow();
    });

    it('passes once every registered request has been made', async () => {
      register('/api/x');
      await request('/api/x');

      expectAllConsumed(agent);
    });
  });

  describe('expectNotRequested', () => {
    it('refuses a path nothing was registered for', () => {
      expect(() => {
        expectNotRequested(agent, '/api/never');
      }).toThrow();
    });

    it('passes while the registered request is still unmade', () => {
      register('/api/x', 'POST');

      expectNotRequested(agent, '/api/x');
    });

    it('fails once that request is made', async () => {
      register('/api/x');
      await request('/api/x');

      expect(() => {
        expectNotRequested(agent, '/api/x');
      }).toThrow();
    });
  });
});
