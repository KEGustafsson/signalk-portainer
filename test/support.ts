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

export function createMockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  // undici's fetch reads the global dispatcher for interceptors registered on
  // this agent; the client is also handed it explicitly.
  setGlobalDispatcher(agent);
  return agent;
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
