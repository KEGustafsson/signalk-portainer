/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppPanel from '../../src/webapp/AppPanel';

// The console dialog fetches a terminal emulator in its own chunk. Standing in
// for it here keeps these tests about the panel: the terminal itself, and every
// way a shell can fail, are covered in ConsoleDialog.test.tsx.
jest.mock('../../src/webapp/xtermterminal', () => ({
  createXtermTerminal: () => ({
    write: () => {},
    onData: () => {},
    onResize: () => {},
    fit: () => {},
    focus: () => {},
    dispose: () => {},
    size: { cols: 80, rows: 24 },
  }),
}));

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

/** Control state as the facade reports it: control on, nothing else. */
const control = {
  allowPutControl: true,
  allowDestructive: false,
  allowSelfManagement: false,
  self: {
    inContainer: true,
    identified: true,
    // Deliberately not one of the container ids above, so the default panel
    // has no self row; the self case has its own test.
    shortId: 'aaaabbbbcccc',
    source: 'cgroup',
    protectionActive: true,
  },
};

/** Routes each facade path to a canned response. */
function routeFetch(overrides: Record<string, unknown> = {}, swarm = false) {
  return jest.fn((input: string, init?: RequestInit) => {
    void init;
    const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0] as string;
    const table: Record<string, unknown> = {
      '/instances': { instances: [{ name: 'boat', isDefault: true }] },
      '/capabilities': { capabilities: { swarm } },
      '/control': control,
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
      // Asserted exactly, not with includes(): a malformed
      // '?all=true?instance=shore' also "includes" the instance, and the facade
      // would quietly serve the default instance instead.
      expect(paths).toContain('/plugins/signalk-portainer/api/containers?all=true&instance=shore');
    });
  });

  it('aborts an in-flight request when the panel unmounts', async () => {
    const signals: AbortSignal[] = [];
    global.fetch = jest.fn((input: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      if (input.includes('/instances')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ instances: [{ name: 'boat', isDefault: true }] }),
        });
      }
      // Never settles: stands in for a facade that has stalled.
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    const { unmount } = render(<AppPanel />);
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));

    expect(signals[0]?.aborted).toBe(false);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('does not surface an aborted request as an error', async () => {
    global.fetch = jest.fn((input: string, init?: RequestInit) => {
      if (input.includes('/instances')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ instances: [{ name: 'boat', isDefault: true }] }),
        });
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const { unmount } = render(<AppPanel />);
    await screen.findByText('Loading…');

    unmount();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('survives a /control response that is missing its fields', async () => {
    // A proxy or an older plugin build can answer with something else; the
    // panel must degrade to "no actions offered", not to a blank page.
    global.fetch = routeFetch({ '/control': {} }) as unknown as typeof fetch;

    render(<AppPanel />);

    expect(await screen.findByText('signalk_influxdb')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });
});

describe('AppPanel container actions', () => {
  const running = 'c1f0e2a3b4c5';
  const stopped = 'd2e1f0a9b8c7';

  /** The row of buttons belonging to one container. */
  const actionsFor = (name: string) =>
    within(screen.getByRole('group', { name: `Actions for ${name}` }));

  const requests = (mock: jest.Mock) =>
    mock.mock.calls.map(
      (call) => `${(call[1] as RequestInit | undefined)?.method ?? 'GET'} ${call[0] as string}`,
    );

  it('starts a stopped container without asking, since nothing is interrupted', async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('ais-logger');

    await user.click(actionsFor('ais-logger').getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(requests(fetchMock)).toContain(
        `POST /plugins/signalk-portainer/api/containers/${stopped}/start?instance=boat`,
      );
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks before stopping, and names the container it would stop', async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    await user.click(actionsFor('signalk_influxdb').getByRole('button', { name: 'Stop' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Stop signalk_influxdb\?/)).toBeInTheDocument();
    // Nothing has been sent yet: the dialog is a decision point, not a receipt.
    expect(requests(fetchMock).some((entry) => entry.startsWith('POST'))).toBe(false);
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');
    await user.click(actionsFor('signalk_influxdb').getByRole('button', { name: 'Stop' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requests(fetchMock).some((entry) => entry.startsWith('POST'))).toBe(false);
  });

  it('stops the container once confirmed', async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');
    await user.click(actionsFor('signalk_influxdb').getByRole('button', { name: 'Stop' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(requests(fetchMock)).toContain(
        `POST /plugins/signalk-portainer/api/containers/${running}/stop?instance=boat`,
      );
    });
    // And the table is re-read rather than left showing the pre-action state.
    expect(
      requests(fetchMock).filter((entry) => entry.includes('/containers?all=true')).length,
    ).toBeGreaterThan(1);
  });

  it('never deletes volumes unless that box is ticked', async () => {
    const fetchMock = routeFetch({
      '/control': { ...control, allowDestructive: true },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('ais-logger');
    await user.click(actionsFor('ais-logger').getByRole('button', { name: 'Remove' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(requests(fetchMock)).toContain(
        `DELETE /plugins/signalk-portainer/api/containers/${stopped}?force=false&removeVolumes=false&instance=boat`,
      );
    });
  });

  it('deletes volumes only when the operator ticks the box', async () => {
    const fetchMock = routeFetch({
      '/control': { ...control, allowDestructive: true },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('ais-logger');
    await user.click(actionsFor('ais-logger').getByRole('button', { name: 'Remove' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText(/anonymous volumes/));
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(requests(fetchMock)).toContain(
        `DELETE /plugins/signalk-portainer/api/containers/${stopped}?force=false&removeVolumes=true&instance=boat`,
      );
    });
  });

  it('offers force only for a container that is actually running', async () => {
    const fetchMock = routeFetch({ '/control': { ...control, allowDestructive: true } });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('ais-logger');

    await user.click(actionsFor('ais-logger').getByRole('button', { name: 'Remove' }));
    expect(within(await screen.findByRole('dialog')).queryByLabelText(/^Force/)).toBeNull();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    await user.click(actionsFor('signalk_influxdb').getByRole('button', { name: 'Remove' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText(/^Force/)).toBeInTheDocument();
  });

  it('keeps a refused action on screen instead of letting the next poll wipe it', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    const fetchMock = routeFetch();
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({
            error: 'Refusing to stop the container running Signal K',
            hint: 'enable "Allow managing the Signal K container itself" if you really mean to',
          }),
        });
      }
      return routeFetch()(input);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');
    await user.click(actionsFor('signalk_influxdb').getByRole('button', { name: 'Stop' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop' }),
    );

    expect(await screen.findByText(/Refusing to stop/)).toBeInTheDocument();

    // Two polls later the refusal is still there to read.
    jest.advanceTimersByTime(25_000);
    await waitFor(() => expect(screen.getByText(/Refusing to stop/)).toBeInTheDocument());
  });

  it('disables every action, with the reason, when control is off', async () => {
    global.fetch = routeFetch({
      '/control': { ...control, allowPutControl: false },
    }) as unknown as typeof fetch;

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    const stop = actionsFor('signalk_influxdb').getByRole('button', { name: 'Stop' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('title', expect.stringContaining('Allow Signal K PUT control'));
  });

  it('disables removal until destructive operations are enabled', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    const row = actionsFor('signalk_influxdb');
    expect(row.getByRole('button', { name: 'Remove' })).toBeDisabled();
    // Control is on, so the non-destructive actions stay available.
    expect(row.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('marks the Signal K container and refuses to offer actions on it', async () => {
    global.fetch = routeFetch({
      '/control': { ...control, self: { ...control.self, shortId: running } },
    }) as unknown as typeof fetch;

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    expect(screen.getByText('Signal K')).toBeInTheDocument();
    const stop = actionsFor('signalk_influxdb').getByRole('button', { name: 'Stop' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('title', expect.stringContaining('running Signal K'));
    // A different container is unaffected by the protection.
    expect(actionsFor('ais-logger').getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('does not paint the old instance over the one just selected', async () => {
    // The action is bound to the instance it started on. If the operator
    // switches while it is in flight, its refresh must not come back and
    // overwrite the new instance's table with the old instance's containers.
    let releasePost: (() => void) | undefined;
    const shoreOnly = [
      {
        Id: '9999aaaa8888',
        Names: ['/shore-only'],
        Image: 'nginx',
        Created: 0,
        State: 'running',
        Status: 'Up',
      },
    ];
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => body });

    global.fetch = jest.fn((input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise((resolve) => {
          releasePost = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        });
      }
      const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0] as string;
      const onShore = input.includes('instance=shore');
      switch (path) {
        case '/instances':
          return ok({
            instances: [
              { name: 'boat', isDefault: true },
              { name: 'shore', isDefault: false },
            ],
          });
        case '/capabilities':
          return ok({ capabilities: { swarm: false } });
        case '/control':
          return ok(control);
        case '/containers':
          return ok({ containers: onShore ? shoreOnly : containers });
        default:
          return ok({});
      }
    }) as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('ais-logger');

    await user.click(actionsFor('ais-logger').getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(releasePost).toBeDefined());

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');
    await screen.findByText('shore-only');

    releasePost?.();

    await waitFor(() => expect(screen.getByText('shore-only')).toBeInTheDocument());
    // Without the guard the stale refresh renders boat's containers here.
    expect(screen.queryByText('ais-logger')).toBeNull();
  });

  it('warns when the plugin cannot identify its own container', async () => {
    global.fetch = routeFetch({
      '/control': {
        ...control,
        self: {
          inContainer: true,
          identified: false,
          source: 'none',
          protectionActive: false,
          warning: 'Running in a container but unable to identify which one',
        },
      },
    }) as unknown as typeof fetch;

    render(<AppPanel />);

    expect(await screen.findByText(/unable to identify which one/)).toBeInTheDocument();
  });
  it('opens the log viewer from a container row', async () => {
    global.fetch = routeFetch({
      '/containers/c1f0e2a3b4c5/logs': { lines: [{ stream: 'stdout', text: 'listening' }] },
    }) as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    await user.click(within(row).getByRole('button', { name: 'Logs' }));

    expect(await screen.findByText('Logs — signalk_influxdb')).toBeInTheDocument();
    expect(await screen.findByText('listening')).toBeInTheDocument();
  });

  it('offers logs for a stopped container too', async () => {
    // The logs of something that exited are the reason to look at them.
    global.fetch = routeFetch() as unknown as typeof fetch;

    render(<AppPanel />);
    await screen.findByText('ais-logger');

    const row = screen.getByRole('group', { name: 'Actions for ais-logger' });
    expect(within(row).getByRole('button', { name: 'Logs' })).toBeEnabled();
  });

  it('offers a console only once the plugin says it can serve one', async () => {
    // The default /control here reports no console, which is what an older
    // Signal K server produces: the button is absent rather than disabled,
    // because there is nothing an operator could do about it.
    global.fetch = routeFetch() as unknown as typeof fetch;

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    expect(within(row).queryByRole('button', { name: 'Console' })).toBeNull();
  });

  it('opens a shell from a container row', async () => {
    global.fetch = routeFetch({
      '/control': { ...control, console: { available: true } },
      '/containers/c1f0e2a3b4c5/exec': {
        id: 'c1f0e2a3b4c5',
        ticket: 'tkt-1',
        session: 'ses-1',
        command: ['/bin/sh'],
      },
    }) as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');

    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    await user.click(within(row).getByRole('button', { name: 'Console' }));

    expect(await screen.findByText('Console — signalk_influxdb')).toBeInTheDocument();
  });

  it('closes the console when the instance changes', async () => {
    // A shell belongs to one container on one Portainer; leaving it open
    // across a switch would relay to a container nobody is looking at.
    global.fetch = routeFetch({
      '/instances': {
        instances: [
          { name: 'boat', isDefault: true },
          { name: 'shore', isDefault: false },
        ],
      },
      '/control': { ...control, console: { available: true } },
      '/containers/c1f0e2a3b4c5/exec': {
        id: 'c1f0e2a3b4c5',
        ticket: 'tkt-1',
        session: 'ses-1',
        command: ['/bin/sh'],
      },
    }) as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');
    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    await user.click(within(row).getByRole('button', { name: 'Console' }));
    await screen.findByText('Console — signalk_influxdb');

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');

    await waitFor(() => expect(screen.queryByText('Console — signalk_influxdb')).toBeNull());
  });

  it('closes the log viewer when the instance changes', async () => {
    // A container id belongs to one Portainer; the other knows nothing about
    // it, and following the switch would only produce a 404.
    global.fetch = routeFetch({
      '/instances': {
        instances: [
          { name: 'boat', isDefault: true },
          { name: 'shore', isDefault: false },
        ],
      },
      '/containers/c1f0e2a3b4c5/logs': { lines: [{ stream: 'stdout', text: 'listening' }] },
    }) as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<AppPanel />);
    await screen.findByText('signalk_influxdb');
    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    await user.click(within(row).getByRole('button', { name: 'Logs' }));
    await screen.findByText('Logs — signalk_influxdb');

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');

    await waitFor(() => expect(screen.queryByText('Logs — signalk_influxdb')).toBeNull());
  });
  describe('stacks', () => {
    const stacksControl = { ...control, allowDestructive: true };

    const stackFetch = (overrides: Record<string, unknown> = {}) =>
      routeFetch({
        '/control': stacksControl,
        '/stacks': {
          stacks: [
            { Id: 3, Name: 'signalk', Type: 2, EndpointId: 1, Status: 1 },
            {
              Id: 5,
              Name: 'from-git',
              Type: 2,
              EndpointId: 1,
              Status: 1,
              GitConfig: { URL: 'https://example.test/stacks' },
            },
          ],
        },
        ...overrides,
      });

    /** Opens the Stacks tab and waits for its rows. */
    const openStacks = async (user: ReturnType<typeof userEvent.setup>) => {
      render(<AppPanel />);
      await screen.findByText('signalk_influxdb');
      await user.click(screen.getByRole('button', { name: 'Stacks' }));
      await screen.findByRole('group', { name: 'Actions for signalk' });
    };

    it('offers redeploy only for the stack that has a repository', async () => {
      global.fetch = stackFetch() as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const plain = screen.getByRole('group', { name: 'Actions for signalk' });
      const git = screen.getByRole('group', { name: 'Actions for from-git' });
      expect(within(plain).queryByRole('button', { name: 'Redeploy' })).toBeNull();
      expect(within(git).getByRole('button', { name: 'Redeploy' })).toBeEnabled();
    });

    it('stops a stack and re-reads immediately', async () => {
      const fetchMock = stackFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      await user.click(within(row).getByRole('button', { name: 'Stop' }));

      await waitFor(() => {
        const calls = fetchMock.mock.calls.map(
          (call) => `${String(call[1]?.method ?? 'GET')} ${String(call[0])}`,
        );
        expect(calls).toContain('POST /plugins/signalk-portainer/api/stacks/3/stop?instance=boat');
      });
      expect(await screen.findByText(/signalk: stopped/)).toBeInTheDocument();
    });

    it('says a started stack was started, not "startped"', async () => {
      const fetchMock = stackFetch({
        '/stacks': {
          stacks: [{ Id: 3, Name: 'signalk', Type: 2, EndpointId: 1, Status: 2 }],
        },
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      await user.click(within(row).getByRole('button', { name: 'Start' }));

      expect(await screen.findByText(/signalk: started/)).toBeInTheDocument();
    });

    it('asks before deleting, and never deletes volumes by implication', async () => {
      const fetchMock = stackFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      await user.click(within(row).getByRole('button', { name: 'Delete' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Delete signalk?')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        const calls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(
          calls.some((path) => path.includes('/stacks/3?removeVolumes=false&instance=boat')),
        ).toBe(true);
      });
    });

    it('disables the destructive button when the configuration does not allow it', async () => {
      global.fetch = stackFetch({ '/control': control }) as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      const remove = within(row).getByRole('button', { name: 'Delete' });
      expect(remove).toBeDisabled();
      expect(remove).toHaveAttribute('title', expect.stringContaining('destructive'));
    });

    it('opens the editor on a row and sends the edited file back', async () => {
      const fetchMock = stackFetch({
        '/stacks/3/file': { content: 'services:\n  influxdb:\n' },
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      await user.click(within(row).getByRole('button', { name: 'Edit' }));

      const file = await screen.findByLabelText('Compose file');
      await waitFor(() => expect(file).toHaveValue('services:\n  influxdb:\n'));
      await user.type(file, '  web:\n');
      await user.click(screen.getByRole('button', { name: 'Deploy' }));

      await waitFor(() => {
        const put = fetchMock.mock.calls.find((call) => call[1]?.method === 'PUT');
        expect(String(put?.[0])).toContain('/stacks/3?instance=boat');
        expect(JSON.parse(String(put?.[1]?.body)).content).toContain('web:');
      });
    });

    it('creates a stack from the New stack button', async () => {
      const fetchMock = stackFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      await user.click(screen.getByRole('button', { name: 'New stack' }));
      await user.type(screen.getByLabelText('Name'), 'weather');
      await user.type(screen.getByLabelText('Compose file'), 'services:\n');
      await user.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        const post = fetchMock.mock.calls.find(
          (call) => call[1]?.method === 'POST' && String(call[0]).includes('/api/stacks?'),
        );
        expect(JSON.parse(String(post?.[1]?.body)).name).toBe('weather');
      });
    });

    it('closes the editor when the instance changes', async () => {
      // A stack id belongs to one Portainer; the other knows nothing about it.
      global.fetch = stackFetch({
        '/instances': {
          instances: [
            { name: 'boat', isDefault: true },
            { name: 'shore', isDefault: false },
          ],
        },
        '/stacks/3/file': { content: 'services:\n' },
      }) as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      await user.click(within(row).getByRole('button', { name: 'Edit' }));
      await screen.findByText('Stack — signalk');

      await user.selectOptions(screen.getByLabelText('Instance'), 'shore');

      await waitFor(() => expect(screen.queryByText('Stack — signalk')).toBeNull());
    });

    it('will not offer a new stack while control is disabled', async () => {
      global.fetch = stackFetch({
        '/control': { ...control, allowPutControl: false },
      }) as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      expect(screen.getByRole('button', { name: 'New stack' })).toBeDisabled();
    });
  });
});
