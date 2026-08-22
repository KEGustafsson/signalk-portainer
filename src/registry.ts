import { PortainerClient, environmentHealth } from './client';
import type { InstanceConfig } from './config';
import { PortainerError } from './errors';
import type { Capabilities, EnvironmentHealth } from './types';

export interface InstanceHealth {
  name: string;
  reachable: boolean;
  baseUrl: string;
  authMode: string;
  portainerVersion?: string;
  environment?: { id: number; name: string; type: number; health: EnvironmentHealth };
  capabilities?: Capabilities;
  error?: string;
  checkedAt: string;
}

export class UnknownInstanceError extends Error {
  constructor(name: string, known: string[]) {
    super(`Unknown Portainer instance "${name}" — configured: ${known.join(', ') || 'none'}`);
    this.name = 'UnknownInstanceError';
  }
}

/**
 * Owns one client per enabled instance. Everything above it addresses an
 * instance by name and is agnostic to how many exist, so a second Portainer is
 * a config entry rather than a code change.
 */
export class InstanceRegistry {
  private readonly clients = new Map<string, PortainerClient>();
  private readonly configs = new Map<string, InstanceConfig>();
  private readonly order: string[] = [];

  constructor(instances: InstanceConfig[], log: (message: string) => void = () => {}) {
    for (const instance of instances) {
      if (!instance.enabled) continue;
      this.order.push(instance.name);
      this.configs.set(instance.name, instance);
      this.clients.set(
        instance.name,
        new PortainerClient({
          baseUrl: instance.baseUrl,
          auth: instance.auth,
          tls: instance.tls,
          timeoutMs: instance.timeoutMs,
          environment: instance.environment,
          log: (message) => log(`[${instance.name}] ${message}`),
        }),
      );
    }
  }

  get names(): string[] {
    return [...this.order];
  }

  get defaultName(): string | undefined {
    return this.order[0];
  }

  /** Omitting the name selects the first enabled instance. */
  get(name?: string): PortainerClient {
    const wanted = name ?? this.defaultName;
    if (!wanted) throw new UnknownInstanceError(name ?? '(default)', this.names);
    const client = this.clients.get(wanted);
    if (!client) throw new UnknownInstanceError(wanted, this.names);
    return client;
  }

  /** Probes every instance in parallel; one failure never hides the others. */
  async health(): Promise<InstanceHealth[]> {
    return Promise.all(this.order.map((name) => this.healthOf(name)));
  }

  private async healthOf(name: string): Promise<InstanceHealth> {
    const config = this.configs.get(name);
    const client = this.clients.get(name);
    const checkedAt = new Date().toISOString();
    const base: InstanceHealth = {
      name,
      reachable: false,
      baseUrl: config?.baseUrl ?? '',
      authMode: config?.auth.mode ?? 'apiKey',
      checkedAt,
    };
    if (!client) return { ...base, error: 'not configured' };

    try {
      const environment = await client.environment();
      const capabilities = await client.capabilities();
      const result: InstanceHealth = {
        ...base,
        reachable: true,
        environment: {
          id: environment.Id,
          name: environment.Name,
          type: environment.Type,
          health: environmentHealth(environment),
        },
        capabilities,
      };
      if (capabilities.portainerVersion) result.portainerVersion = capabilities.portainerVersion;
      return result;
    } catch (cause) {
      return {
        ...base,
        error: cause instanceof PortainerError ? cause.message : String(cause),
      };
    }
  }

  invalidate(): void {
    for (const client of this.clients.values()) client.invalidate();
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
