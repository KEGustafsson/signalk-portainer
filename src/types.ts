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

// ── Docker Engine API shapes (via the Portainer docker proxy) ──────────────
// Narrowed to the fields the UI reads. The proxy returns Docker's own bodies
// unchanged, so these mirror the Docker Engine API rather than Portainer.

export interface DockerPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface DockerContainer {
  Id: string;
  Names: string[];
  Image: string;
  ImageID?: string;
  Command?: string;
  Created: number;
  /** "running" | "exited" | "paused" | "restarting" | "created" | "dead" */
  State: string;
  /** Human text, e.g. "Up 3 days (healthy)". */
  Status: string;
  Ports?: DockerPort[];
  Labels?: Record<string, string>;
  Mounts?: { Name?: string; Source?: string; Destination: string; RW?: boolean }[];
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

export interface DockerContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  Image: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    Running?: boolean;
    Paused?: boolean;
    Restarting?: boolean;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: { Status?: string; FailingStreak?: number };
  };
  Config?: {
    Image?: string;
    Env?: string[];
    Labels?: Record<string, string>;
    Cmd?: string[];
  };
  HostConfig?: { RestartPolicy?: { Name?: string }; NetworkMode?: string };
}

export interface DockerImage {
  Id: string;
  ParentId?: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Created: number;
  Size: number;
  Containers?: number;
}

export interface DockerVolume {
  Name: string;
  Driver: string;
  Mountpoint?: string;
  CreatedAt?: string;
  Scope?: string;
  Labels?: Record<string, string> | null;
}

export interface DockerVolumeList {
  Volumes: DockerVolume[] | null;
  Warnings?: string[] | null;
}

export interface DockerNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  Internal?: boolean;
  Attachable?: boolean;
  Labels?: Record<string, string> | null;
}

export interface DockerDiskUsage {
  LayersSize?: number;
  Images?: DockerImage[] | null;
  Containers?: DockerContainer[] | null;
  Volumes?: DockerVolume[] | null;
  BuildCache?: { Size?: number }[] | null;
}

export interface DockerService {
  ID: string;
  Version?: { Index: number };
  CreatedAt?: string;
  UpdatedAt?: string;
  Spec?: {
    Name?: string;
    Labels?: Record<string, string>;
    Mode?: { Replicated?: { Replicas?: number }; Global?: object };
    TaskTemplate?: { ContainerSpec?: { Image?: string } };
  };
}

export interface DockerNode {
  ID: string;
  Spec?: { Role?: string; Availability?: string };
  Description?: { Hostname?: string; Platform?: { Architecture?: string; OS?: string } };
  Status?: { State?: string; Addr?: string };
  ManagerStatus?: { Leader?: boolean; Reachability?: string };
}

// ── Portainer stack shapes ────────────────────────────────────────────────

export const StackStatus = {
  Active: 1,
  Inactive: 2,
} as const;

export interface Stack {
  Id: number;
  Name: string;
  /** 1 = swarm, 2 = compose/standalone, 3 = kubernetes. */
  Type: number;
  EndpointId: number;
  SwarmId?: string;
  EntryPoint?: string;
  /** 1 = active, 2 = inactive. */
  Status?: number;
  CreationDate?: number;
  UpdateDate?: number;
  Env?: { name: string; value: string }[];
  GitConfig?: { URL?: string; ReferenceName?: string; ConfigFilePath?: string } | null;
  /** Portainer's own polling or webhook redeploy, if the stack has one. */
  AutoUpdate?: { Interval?: string; Webhook?: string; ForcePullImage?: boolean } | null;
}
