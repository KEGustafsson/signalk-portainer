/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppPanel from '../../src/webapp/AppPanel';

const containers = [
  {
    Id: 'c1f0e2a3b4c5',
    Names: ['/signalk_influxdb'],
    Image: 'influxdb:2.7',
    Created: Math.floor(Date.now() / 1000) - 3600,
    State: 'running',
    Status: 'Up 1 hour (healthy)',
    Ports: [{ PrivatePort: 8086, PublicPort: 8086, Type: 'tcp' }],
  },
  {
    Id: 'd2e1f0a9b8c7',
    Names: ['/ais-logger'],
    Image: 'ghcr.io/example/ais-logger:1.4.0',
    Created: Math.floor(Date.now() / 1000) - 7200,
    State: 'exited',
    Status: 'Exited (1) 2 hours ago',
  },
];

/** Routes each facade path to a canned response. */
function routeFetch(overrides: Record<string, unknown> = {}, swarm = false) {
  return jest.fn((input: string) => {
    const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0] as string;
    const table: Record<string, unknown> = {
      '/instances': { instances: [{ name: 'boat', isDefault: true }] },
      '/capabilities': { capabilities: { swarm } },
      '/containers': { containers },
      '/environments': {
        environments: [
          { id: 1, name: 'local', type: 1, health: 'up', isSelected: true, url: 'unix://' },
        ],
      },
      '/stacks': { stacks: [{ Id: 3, Name: 'signalk', Type: 2, EndpointId: 1, Status: 1 }] },
      '/swarm/services': { services: [{ ID: 'svc1', Spec: { Name: 'web' } }] },
      ...overrides,
    };
    const body = table[path] ?? {};
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
}

describe('AppPanel', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders containers for the default instance on load', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;

    render(<AppPanel />);

    expect(await screen.findByText('signalk_influxdb')).toBeInTheDocument();
    expect(screen.getByText('ais-logger')).toBeInTheDocument();
    // State badges, not just raw text.
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('exited')).toBeInTheDocument();
  });

  it('requests stopped containers too, so an exited one is visible', async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    const paths = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(paths.some((path) => path.includes('/containers?all=true'))).toBe(true);
  });

  it('switches tab and renders that resource', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    await user.click(screen.getByRole('button', { name: 'Stacks' }));

    expect(await screen.findByText('signalk')).toBeInTheDocument();
  });

  it('hides the swarm tabs when the daemon is not a swarm', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    expect(screen.queryByRole('button', { name: 'Services' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nodes' })).not.toBeInTheDocument();
  });

  it('shows the swarm tabs when the daemon is a swarm member', async () => {
    global.fetch = routeFetch({}, true) as unknown as typeof fetch;

    render(<AppPanel />);

    expect(await screen.findByRole('button', { name: 'Services' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nodes' })).toBeInTheDocument();
  });

  it('hides the instance selector when only one instance is configured', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    expect(screen.queryByLabelText('Instance')).not.toBeInTheDocument();
  });

  it('offers a selector and reloads against the chosen instance', async () => {
    const fetchMock = routeFetch({
      '/instances': {
        instances: [
          { name: 'boat', isDefault: true },
          { name: 'shore', isDefault: false },
        ],
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');

    await waitFor(() => {
      const paths = fetchMock.mock.calls.map((call) => call[0] as string);
      expect(paths.some((path) => path.includes('instance=shore'))).toBe(true);
    });
  });

  it('shows the facade error and its hint instead of an empty table', async () => {
    global.fetch = jest.fn((input: string) => {
      if (input.includes('/instances')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ instances: [{ name: 'boat', isDefault: true }] }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 502,
        json: async () => ({
          error: 'Portainer GET /api/endpoints could not be reached',
          hint: 'check host, port and protocol',
        }),
      });
    }) as unknown as typeof fetch;

    render(<AppPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached');
    expect(screen.getByRole('alert')).toHaveTextContent('check host, port and protocol');
  });

  it('renders an empty state rather than a bare table', async () => {
    global.fetch = routeFetch({ '/containers': { containers: [] } }) as unknown as typeof fetch;

    render(<AppPanel />);

    expect(await screen.findByText('No containers')).toBeInTheDocument();
  });
});
