import { MockAgent, setGlobalDispatcher } from 'undici';
import { PortainerClient, type PortainerClientOptions } from '../src/client';

export const BASE_URL = 'https://portainer.test:9443';

export function createMockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  // undici's fetch reads the global dispatcher for interceptors registered on
  // this agent; the client is also handed it explicitly.
  setGlobalDispatcher(agent);
  return agent;
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
