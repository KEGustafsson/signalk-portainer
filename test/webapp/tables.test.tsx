/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import {
  ContainersTable,
  EnvironmentsTable,
  ImagesTable,
  NetworksTable,
  NodesTable,
  ServicesTable,
  StacksTable,
  VolumesTable,
} from '../../src/webapp/tables';

/**
 * Docker omits fields freely — no ports, no mountpoint, no repo tags, no
 * hostname. These cover the fallbacks that would otherwise render "undefined"
 * in front of an operator.
 */
describe('tables with sparse Docker data', () => {
  it('renders a container with no published ports', () => {
    render(
      <ContainersTable
        rows={[
          {
            Id: 'abc123def456',
            Names: ['/lonely'],
            Image: 'alpine',
            Created: 0,
            State: 'paused',
            Status: 'Paused',
          },
        ]}
      />,
    );

    expect(screen.getByText('lonely')).toBeInTheDocument();
    // No ports and no created time both fall back to a dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('hides unpublished ports but shows published ones', () => {
    render(
      <ContainersTable
        rows={[
          {
            Id: 'p1',
            Names: ['/ports'],
            Image: 'nginx',
            Created: 1,
            State: 'running',
            Status: 'Up',
            Ports: [
              { PrivatePort: 80, Type: 'tcp' },
              { PrivatePort: 443, PublicPort: 8443, Type: 'tcp' },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText('8443→443')).toBeInTheDocument();
  });

  it('labels an untagged image', () => {
    render(<ImagesTable rows={[{ Id: 'sha256:deadbeef0000', Created: 1, Size: 1500 }]} />);

    expect(screen.getByText('<untagged>')).toBeInTheDocument();
    expect(screen.getByText('1.5 kB')).toBeInTheDocument();
  });

  it('renders a volume without a mountpoint', () => {
    render(<VolumesTable rows={[{ Name: 'data', Driver: 'local' }]} />);

    expect(screen.getByText('data')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('distinguishes internal from external networks', () => {
    render(
      <NetworksTable
        rows={[
          { Id: 'n1', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
          { Id: 'n2', Name: 'private', Driver: 'bridge', Scope: 'local', Internal: true },
        ]}
      />,
    );

    expect(screen.getByText('yes')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();
  });

  it('marks the swarm leader and falls back to an id without a hostname', () => {
    render(
      <NodesTable
        rows={[
          {
            ID: 'node1',
            Description: { Hostname: 'boatpi' },
            Spec: { Role: 'manager', Availability: 'active' },
            Status: { State: 'ready' },
            ManagerStatus: { Leader: true },
          },
          { ID: 'node2longidvalue' },
        ]}
      />,
    );

    expect(screen.getByText('leader')).toBeInTheDocument();
    expect(screen.getByText('boatpi')).toBeInTheDocument();
    expect(screen.getByText('node2longidv')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('separates global from replicated services', () => {
    render(
      <ServicesTable
        rows={[
          {
            ID: 's1',
            Spec: {
              Name: 'web',
              Mode: { Replicated: { Replicas: 3 } },
              TaskTemplate: { ContainerSpec: { Image: 'nginx' } },
            },
          },
          { ID: 's2abcdefghijk', Spec: { Mode: { Global: {} } } },
        ]}
      />,
    );

    expect(screen.getByText('replicated')).toBeInTheDocument();
    expect(screen.getByText('global')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('s2abcdefghij')).toBeInTheDocument();
  });

  it('names every stack type and its source', () => {
    render(
      <StacksTable
        rows={[
          { Id: 1, Name: 'compose', Type: 2, EndpointId: 1, Status: 1 },
          { Id: 2, Name: 'swarm', Type: 1, EndpointId: 1, Status: 2 },
          {
            Id: 3,
            Name: 'k8s',
            Type: 3,
            EndpointId: 1,
            Status: 1,
            GitConfig: { URL: 'https://example.test/repo' },
          },
        ]}
      />,
    );

    expect(screen.getByText('Compose')).toBeInTheDocument();
    expect(screen.getByText('Swarm')).toBeInTheDocument();
    expect(screen.getByText('Kubernetes')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
    expect(screen.getByText('https://example.test/repo')).toBeInTheDocument();
    // The two stacks without a GitConfig both read as file-sourced.
    expect(screen.getAllByText('file')).toHaveLength(2);
  });

  it('names known environment types and falls back for unknown ones', () => {
    render(
      <EnvironmentsTable
        rows={[
          { id: 1, name: 'local', type: 1, health: 'up', isSelected: true, url: 'unix://' },
          { id: 2, name: 'edge', type: 4, health: 'down', isSelected: false },
          { id: 3, name: 'future', type: 99, health: 'unknown', isSelected: false },
        ]}
      />,
    );

    expect(screen.getByText('Local Docker')).toBeInTheDocument();
    expect(screen.getByText('Edge agent')).toBeInTheDocument();
    expect(screen.getByText('Type 99')).toBeInTheDocument();
    expect(screen.getByText('selected')).toBeInTheDocument();
  });
});

describe('tables with nothing to show', () => {
  it('renders an explanatory empty state for each resource', () => {
    const cases: [string, React.ReactElement][] = [
      ['No environments', <EnvironmentsTable rows={[]} key="e" />],
      ['No containers', <ContainersTable rows={[]} key="c" />],
      ['No stacks in this environment', <StacksTable rows={[]} key="s" />],
      ['No images', <ImagesTable rows={[]} key="i" />],
      ['No volumes', <VolumesTable rows={[]} key="v" />],
      ['No networks', <NetworksTable rows={[]} key="n" />],
      ['No services', <ServicesTable rows={[]} key="sv" />],
      ['No nodes', <NodesTable rows={[]} key="nd" />],
    ];

    for (const [message, element] of cases) {
      const { unmount } = render(element);
      expect(screen.getByText(message)).toBeInTheDocument();
      unmount();
    }
  });
});
