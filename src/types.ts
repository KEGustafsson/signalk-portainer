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

/**
 * Edge-agent settings. Only `AsyncMode` and the three async intervals matter
 * here: they decide how often the agent is expected to check in, and so how
 * stale a check-in has to be before the environment is really down.
 */
export interface EnvironmentEdgeSettings {
  AsyncMode?: boolean;
  /** Seconds. Async mode only; standard mode uses EdgeCheckinInterval. */
  PingInterval?: number;
  /** Seconds. Async mode only. */
  SnapshotInterval?: number;
  /** Seconds. Async mode only. */
  CommandInterval?: number;
}

export interface Environment {
  Id: number;
  Name: string;
  Type: number;
  /** 1 = up, 2 = down. Meaningless for edge types. */
  Status?: number;
  URL?: string;
  /**
   * Portainer's own up/down verdict for an edge environment, computed by the
   * endpoint list handler on Portainer's clock and with the async intervals it
   * alone knows. This is what Portainer's UI shows, so it is what this plugin
   * shows. Absent on Portainer versions old enough not to publish it.
   */
  Heartbeat?: boolean;
  /** Epoch seconds, on Portainer's clock. Edge environments only. */
  LastCheckInDate?: number;
  /** Seconds. Edge environments in standard (non-async) mode only. */
  EdgeCheckinInterval?: number;
  /** Edge environments only. */
  Edge?: EnvironmentEdgeSettings;
}

export interface PortainerStatus {
  Version: string;
  InstanceID?: string;
}

/** `GET /api/system/version`: whether Portainer itself has an update waiting. */
export interface PortainerVersion {
  ServerVersion?: string;
  LatestVersion?: string;
  UpdateAvailable?: boolean;
  ServerEdition?: string;
}

/** Whether this plugin can manage an environment, and why not when it cannot. */
export type EnvironmentSupport = { supported: true } | { supported: false; reason: string };

export interface DockerSwarmInfo {
  LocalNodeState?: string;
  NodeID?: string;
  /** True on a manager, where the cluster can be read and written. */
  ControlAvailable?: boolean;
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
  /** True when the daemon is an active swarm manager. */
  swarm: boolean;
  /** Present only when swarm is true; required by swarm stack creation. */
  swarmId?: string;
  dockerVersion?: string;
  portainerVersion?: string;
  /** The newest Portainer release, when Portainer was able to check. */
  portainerLatestVersion?: string;
  portainerUpdateAvailable?: boolean;
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
    /** True when the log stream is raw bytes rather than Docker's framing. */
    Tty?: boolean;
    /** Seconds Docker waits after SIGTERM before SIGKILL, if the image set one. */
    StopTimeout?: number;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    NetworkMode?: string;
  };
}

/**
 * `GET /containers/{id}/stats?stream=false`, as far as it is read. Every
 * field is optional: a container that has just exited, a cgroup v1 host and
 * a daemon without a network namespace each leave parts of it out.
 */
export interface DockerContainerStats {
  read?: string;
  cpu_stats?: DockerCpuStats;
  precpu_stats?: DockerCpuStats;
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: { io_service_bytes_recursive?: { op?: string; value?: number }[] | null };
  pids_stats?: { current?: number };
}

export interface DockerCpuStats {
  cpu_usage?: { total_usage?: number; percpu_usage?: number[] | null };
  system_cpu_usage?: number;
  online_cpus?: number;
}

/** One stats reading, reduced to what an operator reads off it. */
export interface ContainerStats {
  /** When Docker took the sample, RFC 3339. */
  read?: string;
  /** Share of the host's CPUs, 0-100 per CPU as `docker stats` reports it. */
  cpuPercent?: number;
  /** Working set: usage less the page cache, as `docker stats` reports it. */
  memoryBytes?: number;
  memoryLimitBytes?: number;
  memoryPercent?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  blockReadBytes?: number;
  blockWriteBytes?: number;
  pids?: number;
}

/** `GET /containers/{id}/top`: `ps` output, one row per process. */
export interface DockerContainerTop {
  Titles: string[];
  Processes: string[][];
}

/**
 * A registry Portainer holds credentials for, as far as this plugin reads it.
 *
 * Deliberately without `Password`: Portainer hides it on the way out, and the
 * plugin never needs it. A pull names the registry by id and Portainer's own
 * proxy substitutes the credentials — see `pullImage`.
 */
export interface PortainerRegistry {
  Id: number;
  Name?: string;
  /** Host and optional port, e.g. `ghcr.io` or `registry.lan:5000`. */
  URL?: string;
  /** 1 Quay, 2 Azure, 3 Custom, 4 GitLab, 5 ProGet, 6 Docker Hub, 7 ECR. */
  Type?: number;
  /** False for a public registry Portainer merely knows the address of. */
  Authentication?: boolean;
}

/** A registry as the panel needs it: enough to name it and nothing more. */
export interface RegistryChoice {
  id: number;
  name: string;
  url?: string;
  /** Whether Portainer holds credentials for it. */
  authenticated: boolean;
}

/**
 * One entry from Docker's event stream, narrowed to what this plugin reads.
 *
 * Docker sends a great deal more per event — the image, the labels, the
 * scope. Only the three fields below decide anything here: what kind of thing
 * changed, what happened to it, and which one it was.
 */
export interface DockerEvent {
  /** `container`, `image`, `network`… — the plugin subscribes to containers. */
  Type?: string;
  /** `start`, `die`, `health_status: unhealthy`, `exec_create: sh`… */
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  /** Seconds since the epoch, as Docker writes it. */
  time?: number;
}

/** What a pull ended with: Docker's last status line, e.g. "Downloaded newer image". */
export interface ImagePullResult {
  reference?: string;
  status: string;
}

export interface DockerImage {
  Id: string;
  ParentId?: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Created: number;
  Size: number;
  /**
   * Bytes this image shares with another. Only /system/df computes it; the
   * image list leaves it out entirely.
   */
  SharedSize?: number;
  /**
   * Containers referencing this image, stopped ones included. Docker computes
   * it for /system/df alone and sends -1 from the image list, which is why the
   * panel reads "in use" from the disk-usage answer rather than from the rows
   * it polls.
   */
  Containers?: number;
}

/** One line of what a removal or a prune did to an image. */
export interface DockerImageRemoval {
  /** A tag that was dropped; the image itself may survive under another. */
  Untagged?: string;
  /** An image id whose layers were actually deleted. */
  Deleted?: string;
}

export interface DockerImagePrune {
  ImagesDeleted?: DockerImageRemoval[] | null;
  SpaceReclaimed?: number;
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

/**
 * Portainer's stack states. The last two arrived with the deploys Portainer
 * runs in the background (updates and redeploys from 2.42, creates from
 * 2.44): a stack is *deploying* until compose finishes, and in *error* when
 * it did not.
 */
export const StackStatus = {
  Active: 1,
  Inactive: 2,
  Deploying: 3,
  Error: 4,
} as const;

export interface Stack {
  Id: number;
  Name: string;
  /** 1 = swarm, 2 = compose/standalone, 3 = kubernetes. */
  Type: number;
  EndpointId: number;
  SwarmId?: string;
  EntryPoint?: string;
  /** 1 = active, 2 = inactive, 3 = deploying, 4 = error; see StackStatus. */
  Status?: number;
  CreationDate?: number;
  UpdateDate?: number;
  Env?: { name: string; value: string }[];
  GitConfig?: {
    URL?: string;
    ReferenceName?: string;
    ConfigFilePath?: string;
    TLSSkipVerify?: boolean;
    /** The credentials Portainer stored with the stack, password withheld. */
    Authentication?: { Username?: string; GitCredentialID?: number } | null;
  } | null;
  /** Portainer's own polling or webhook redeploy, if the stack has one. */
  AutoUpdate?: {
    Interval?: string;
    Webhook?: string;
    /** Portainer's own handle on the polling job; not ours to set. */
    JobID?: string;
    ForceUpdate?: boolean;
    ForcePullImage?: boolean;
  } | null;
  /**
   * Swarm-only, and only `Prune`. Held here because the route that changes
   * auto-update rewrites it from its own payload, so it has to be echoed back.
   */
  Option?: { Prune?: boolean } | null;
  /** What a background deploy reported, newest last. */
  DeploymentStatus?: { Type?: number; Message?: string; Timestamp?: number }[] | null;
}
