/**
 * Portainer CE 2.x and Docker Engine API shapes, narrowed to the fields this
 * plugin actually reads. See docs/portainer-api.md for the researched surface.
 */

/** Portainer environment ("endpoint") types. */
export const EnvironmentType = {
  LocalDocker: 1,
  AgentOnDocker: 2,
  AzureACI: 3,
  EdgeAgentOnDocker: 4,
  LocalKubernetes: 5,
  AgentOnKubernetes: 6,
  EdgeAgentOnKubernetes: 7,
} as const;

export type EnvironmentTypeValue = (typeof EnvironmentType)[keyof typeof EnvironmentType];

/** Edge environments report health by check-in recency, not by Status. */
export const EDGE_ENVIRONMENT_TYPES: readonly number[] = [
  EnvironmentType.EdgeAgentOnDocker,
  EnvironmentType.EdgeAgentOnKubernetes,
];

export interface Environment {
  Id: number;
  Name: string;
  Type: number;
  /** 1 = up, 2 = down. Meaningless for edge types. */
  Status?: number;
  URL?: string;
  /** Epoch seconds. Edge environments only. */
  LastCheckInDate?: number;
  /** Seconds. Edge environments only. */
  EdgeCheckinInterval?: number;
}

export interface PortainerStatus {
  Version: string;
  InstanceID?: string;
}

export interface DockerSwarmInfo {
  LocalNodeState?: string;
  NodeID?: string;
  Cluster?: { ID?: string };
}

export interface DockerInfo {
  ServerVersion?: string;
  Swarm?: DockerSwarmInfo;
  Containers?: number;
  ContainersRunning?: number;
  ContainersStopped?: number;
  Images?: number;
  Name?: string;
  OperatingSystem?: string;
}

export interface Capabilities {
  /** True when the daemon is an active swarm manager or worker. */
  swarm: boolean;
  /** Present only when swarm is true; required by swarm stack creation. */
  swarmId?: string;
  dockerVersion?: string;
  portainerVersion?: string;
}

export type EnvironmentHealth = 'up' | 'down' | 'unknown';
