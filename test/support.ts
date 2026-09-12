import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { PortainerClient, type PortainerClientOptions } from '../src/client';

export const BASE_URL = 'https://portainer.test:9443';

/**
 * The dispatcher undici had before any test replaced it.
 *
 * `setGlobalDispatcher` writes to a process-global, so an agent installed by
 * one test file outlives it: without putting the original back, the rest of
 * the run — every test that never asked for a MockAgent — talks to an agent
 * that has since been closed, and fails for a reason that has nothing to do
 * with what it is testing.
 */
const original: Dispatcher = getGlobalDispatcher();

/** How many interceptors each agent has had registered on it. */
const registrations = new WeakMap<MockAgent, { count: number }>();

/** Marks a pool whose `intercept` is already counted, so it is wrapped once. */
const counted = Symbol('counted');

type Pool = ReturnType<MockAgent['get']>;

export function createMockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  // Every interceptor registered through this agent is counted, so that
  // `expectAllConsumed` can tell "the code made no request this test did not
  // expect" apart from "this test expected nothing".
  const tally = { count: 0 };
  registrations.set(agent, tally);
  const poolFor = agent.get.bind(agent);
  agent.get = ((origin: Parameters<MockAgent['get']>[0]) => {
    const pool: Pool & { [counted]?: true } = poolFor(origin);
    if (pool[counted] !== true) {
      pool[counted] = true;
      const intercept = pool.intercept.bind(pool);
      pool.intercept = (options: Parameters<Pool['intercept']>[0]) => {
        tally.count += 1;
        return intercept(options);
      };
    }
    return pool;
  }) as MockAgent['get'];
  // undici's fetch reads the global dispatcher for interceptors registered on
  // this agent; the client is also handed it explicitly.
  setGlobalDispatcher(agent);
  return agent;
}

/**
 * Asserts that every interceptor registered on this agent was consumed — and
 * that there was at least one of them.
 *
 * `expect(agent.pendingInterceptors()).toHaveLength(0)` on its own reads as
 * "the code made exactly the requests this test expected", but it holds just
 * as well when the code made none and the test expected none: an empty set
 * has nothing left over. A test that registers its interceptors through a
 * helper it later stops calling, or one written against a route that moved,
 * goes on passing while exercising nothing. Counting the registrations is
 * what makes the emptiness mean something.
 */
export function expectAllConsumed(agent: MockAgent): void {
  expect(registrations.get(agent)?.count ?? 0).toBeGreaterThan(0);
  expect(agent.pendingInterceptors()).toHaveLength(0);
}

/**
 * Asserts that a request the code must not make was not made.
 *
 * The interceptor for `path` has to be registered for this to pass, which is
 * the whole point: the obvious way to write this assertion — filtering the
 * pending set for the path and expecting nothing — is satisfied by a path
 * nobody ever registered, so it goes on passing when the route is renamed, or
 * when the guard it was written to prove stops working. Registering the
 * request that must not happen and requiring it to be *left over* cannot be
 * satisfied that way.
 */
export function expectNotRequested(agent: MockAgent, path: string): void {
  expect(agent.pendingInterceptors().map((interceptor) => String(interceptor.path))).toContain(
    path,
  );
}

/** Puts undici's own dispatcher back. Call it wherever createMockAgent is closed. */
export function restoreGlobalDispatcher(): void {
  setGlobalDispatcher(original);
}

export function createClient(
  agent: MockAgent,
  overrides: Partial<PortainerClientOptions> = {},
): PortainerClient {
  return new PortainerClient({
    baseUrl: BASE_URL,
    auth: { mode: 'apiKey', apiKey: 'ptr_secrettoken' },
    dispatcher: agent,
    ...overrides,
  });
}

/**
 * A parsed JSON body: any key, any JSON value, and specifically not `any`.
 *
 * supertest types `res.body` as `any`, and `Response.json()` resolves to `any`
 * too, so every assertion reached through them is unchecked — the type-aware
 * rules said so 135 times. This keeps the looseness a fixture needs while
 * stopping `any` from spreading out of the response and into the test.
 */
export interface JsonBody {
  [key: string]: JsonValue;
}

export type JsonValue = string | number | boolean | null | undefined | JsonValue[] | JsonBody;

/**
 * Reads a response body as JSON.
 *
 * The default is deliberately vague — most assertions only reach one key deep
 * and gain nothing from a declared shape. Pass a type argument where the test
 * indexes into the body, which vagueness cannot express: `asJson<{ instances:
 * { reachable: boolean }[] }>(res.body)`.
 */
export function asJson<T = JsonBody>(value: unknown): T {
  return value as T;
}
