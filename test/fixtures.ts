import type {
  DockerContainer,
  DockerContainerInspect,
  DockerImage,
  DockerInfo,
  DockerNetwork,
  DockerVolumeList,
  Environment,
  PortainerStatus,
  Stack,
} from '../src/types';

export const systemStatus: PortainerStatus = {
  Version: '2.21.4',
  InstanceID: '9c1b0a4e-0f2f-4a55-9a35-8f7f2f7f0a11',
};

export const localEnvironment: Environment = {
  Id: 1,
  Name: 'local',
  Type: 1,
  Status: 1,
  URL: 'unix:///var/run/docker.sock',
};

export const nasEnvironment: Environment = {
  Id: 4,
  Name: 'nas',
  Type: 2,
  Status: 2,
  URL: 'tcp://10.0.0.9:9001',
};

export const edgeEnvironment: Environment = {
  Id: 7,
  Name: 'shore',
  Type: 4,
  Status: 1,
  EdgeCheckinInterval: 30,
  LastCheckInDate: 0,
};

export const standaloneInfo: DockerInfo = {
  ServerVersion: '27.3.1',
  Containers: 6,
  ContainersRunning: 5,
  ContainersStopped: 1,
  Images: 12,
  Name: 'boatpi',
  OperatingSystem: 'Raspbian GNU/Linux 12 (bookworm)',
  Swarm: { LocalNodeState: 'inactive' },
};

export const swarmInfo: DockerInfo = {
  ServerVersion: '27.3.1',
  Swarm: {
    LocalNodeState: 'active',
    NodeID: 'x7k2p9',
    Cluster: { ID: 'abc123swarmcluster' },
  },
};

export const containers: DockerContainer[] = [
  {
    Id: 'c1f0e2a3b4c5',
    Names: ['/signalk_influxdb'],
    Image: 'influxdb:2.7',
    Created: 1_760_000_000,
    State: 'running',
    Status: 'Up 3 days (healthy)',
    Ports: [{ PrivatePort: 8086, PublicPort: 8086, Type: 'tcp' }],
    Labels: {
      'com.docker.compose.project': 'signalk',
      'com.docker.compose.service': 'influxdb',
    },
  },
  {
    Id: 'd2e1f0a9b8c7',
    Names: ['/ais-logger'],
    Image: 'ghcr.io/example/ais-logger:1.4.0',
    Created: 1_759_000_000,
    State: 'exited',
    Status: 'Exited (1) 2 hours ago',
  },
];

export const containerInspect: DockerContainerInspect = {
  Id: 'c1f0e2a3b4c5',
  Name: '/signalk_influxdb',
  Created: '2026-08-01T10:00:00.000Z',
  Image: 'sha256:abc123',
  RestartCount: 0,
  State: { Status: 'running', Running: true, Health: { Status: 'healthy' } },
  Config: { Image: 'influxdb:2.7' },
};

export const images: DockerImage[] = [
  { Id: 'sha256:aaa', RepoTags: ['influxdb:2.7'], Created: 1_755_000_000, Size: 412_000_000 },
];

export const networks: DockerNetwork[] = [
  { Id: 'net1', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
];

export const volumeList: DockerVolumeList = {
  Volumes: [{ Name: 'influxdb-data', Driver: 'local', Scope: 'local' }],
};

export const emptyVolumeList: DockerVolumeList = { Volumes: null };

export const stacks: Stack[] = [
  { Id: 3, Name: 'signalk', Type: 2, EndpointId: 1, Status: 1 },
  { Id: 9, Name: 'elsewhere', Type: 2, EndpointId: 4, Status: 1 },
];
