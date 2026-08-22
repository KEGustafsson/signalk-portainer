import type { DockerInfo, Environment, PortainerStatus } from '../src/types';

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
