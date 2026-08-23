/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    // No actions prop, so no Actions column and nothing to click.
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
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

    // Only a real "down" earns the red badge; "unknown" is not an outage.
    expect(screen.getByText('up')).toHaveClass('bg-success');
    expect(screen.getByText('down')).toHaveClass('bg-danger');
    expect(screen.getByText('unknown')).toHaveClass('bg-secondary');
  });

  describe('choosing an environment from the table', () => {
    const rows = [
      { id: 1, name: 'primary', type: 1, health: 'up', isSelected: true },
      { id: 27, name: 'lenovo', type: 2, health: 'up', isSelected: false },
    ];

    it('offers no way to choose when nothing can be chosen', () => {
      render(<EnvironmentsTable rows={rows} />);

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('names each button after its own environment', () => {
      render(<EnvironmentsTable rows={rows} actions={{ onSelect: () => {} }} />);

      // Half a dozen buttons all reading "Select" tell a screen reader nothing
      // about which host they would switch to.
      expect(screen.getByRole('button', { name: 'Select lenovo' })).toBeInTheDocument();
    });

    it('reports the id of the row that was pressed', async () => {
      const user = userEvent.setup();
      const onSelect = jest.fn();
      render(<EnvironmentsTable rows={rows} actions={{ onSelect }} />);

      await user.click(screen.getByRole('button', { name: 'Select lenovo' }));
      expect(onSelect).toHaveBeenCalledWith(27);

      onSelect.mockClear();
      await user.click(screen.getByText('lenovo'));
      // Once: the button sits inside the row that would otherwise answer the
      // same press a second time.
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(27);
    });

    it('takes no press while a switch is still going through', async () => {
      const user = userEvent.setup();
      const onSelect = jest.fn();
      render(<EnvironmentsTable rows={rows} actions={{ onSelect, busy: true }} />);

      await user.click(screen.getByRole('button', { name: 'Select lenovo' }));
      await user.click(screen.getByText('lenovo'));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not offer the environment already in use', async () => {
      const user = userEvent.setup();
      const onSelect = jest.fn();
      render(<EnvironmentsTable rows={rows} actions={{ onSelect }} />);

      expect(screen.queryByRole('button', { name: 'Select primary' })).not.toBeInTheDocument();
      await user.click(screen.getByText('primary'));
      expect(onSelect).not.toHaveBeenCalled();
    });
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

describe('the console button', () => {
  const row = {
    Id: 'c1f0e2a3b4c5d6e7',
    Names: ['/influx'],
    Image: 'influxdb:2.7',
    Created: 0,
    State: 'running',
    Status: 'Up 1 hour',
  };
  const control = {
    allowPutControl: true,
    allowDestructive: false,
    allowSelfManagement: false,
    console: { available: true },
    self: {
      inContainer: true,
      identified: true,
      shortId: 'aaaabbbbcccc',
      source: 'cgroup',
      protectionActive: true,
    },
  };

  const show = (
    overrides: Record<string, unknown> = {},
    rowOverrides: Record<string, unknown> = {},
  ) =>
    render(
      <ContainersTable
        rows={[{ ...row, ...rowOverrides }]}
        actions={{
          control: { ...control, ...overrides },
          onAction: () => {},
          onConsole: () => {},
        }}
      />,
    );

  it('offers a shell in a running container', () => {
    show();

    expect(screen.getByRole('button', { name: 'Console' })).toBeEnabled();
  });

  it('explains itself rather than opening a dialog that would be refused', () => {
    show({}, { State: 'exited' });

    const button = screen.getByRole('button', { name: 'Console' });
    // Inert rather than `disabled`: a disabled button cannot be focused, so
    // the reason in `title` is unreachable from a keyboard and unread by most
    // screen readers — which leaves the panel explaining itself only to the
    // operators who could already hover.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('The container is not running');
    expect(button).toHaveAttribute('title', 'The container is not running');
  });

  it('drops the press on the inert button rather than opening the dialog', async () => {
    const user = userEvent.setup();
    const onConsole = jest.fn();
    render(
      <ContainersTable
        rows={[{ ...row, State: 'exited' }]}
        actions={{ control, onAction: () => {}, onConsole }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Console' });
    // Focusable — that is the whole point — so the click has to be refused by
    // the handler rather than by the browser.
    button.focus();
    expect(button).toHaveFocus();
    await user.click(button);

    expect(onConsole).not.toHaveBeenCalled();
  });

  it('is absent entirely when the panel was given no way to open one', () => {
    // Rather than permanently disabled: on a Signal K server that cannot serve
    // a WebSocket there is nothing an operator could do about it.
    render(<ContainersTable rows={[row]} actions={{ control, onAction: () => {} }} />);

    expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
  });
});
