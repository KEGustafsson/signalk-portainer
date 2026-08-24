/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppPanel from '../../src/webapp/AppPanel';
import { asResponse, type FetchMock, jsonBody } from './mocks';

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
function routeFetch(overrides: Record<string, unknown> = {}, swarm = false): FetchMock {
  return jest.fn((input: string, init?: RequestInit) => {
    void init;
    const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0] as string;
    const table: Record<string, unknown> = {
      '/instances': { instances: [{ name: 'boat', isDefault: true }] },
      '/capabilities': { capabilities: { swarm } },
      '/control': control,
      '/containers': { containers },
      '/environments': {
        selected: 1,
        environments: [
          { id: 1, name: 'local', type: 1, health: 'up', isSelected: true, url: 'unix://' },
        ],
      },
      '/stacks': { stacks: [{ Id: 3, Name: 'signalk', Type: 2, EndpointId: 1, Status: 1 }] },
      '/swarm/services': { services: [{ ID: 'svc1', Spec: { Name: 'web' } }] },
      ...overrides,
    };
    const body = table[path] ?? {};
    return Promise.resolve(
      asResponse({ ok: true, status: 200, json: () => Promise.resolve(body) }),
    );
  });
}

/**
 * Renders the panel and opens the Containers tab.
 *
 * The panel lands on Environments — which Docker host it is working against is
 * the first thing an operator needs to see, and on a Portainer with several it
 * is the first thing they have to answer — so a test about containers asks for
 * them rather than assuming the tab it starts on.
 */
async function showContainers(): Promise<void> {
  render(<AppPanel />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Containers' }));
  // Waited for, not just clicked: the reads the panel starts as it mounts
  // settle inside this act() rather than after the test has moved on, which
  // React reports as an unwrapped update.
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Containers' })).toHaveClass('active'),
  );
}

describe('AppPanel', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * A Portainer managing several Docker hosts with no choice made. Before the
   * picker this was a dead end: the panel showed the refusal and the only way
   * out was editing the plugin configuration by hand.
   */
  describe('choosing an environment', () => {
    const unchosen = (selected: number | null = null) =>
      routeFetch({
        '/environments': {
          selected,
          environments: [
            { id: 1, name: 'primary', type: 1, health: 'up', isSelected: selected === 1 },
            { id: 27, name: 'lenovo', type: 2, health: 'up', isSelected: selected === 27 },
          ],
        },
      });

    it('asks instead of guessing which Docker host to work against', async () => {
      global.fetch = unchosen() as unknown as typeof fetch;

      render(<AppPanel />);

      expect(await screen.findByText('Choose an environment to continue')).toBeInTheDocument();
      // The tables stay empty rather than showing another environment's
      // containers, and no container read is attempted at all.
      expect(screen.queryByText('signalk_influxdb')).not.toBeInTheDocument();
    });

    it('lands on the environments, and offers every one Portainer reported', async () => {
      global.fetch = unchosen() as unknown as typeof fetch;

      render(<AppPanel />);

      // No tab is clicked: this is where the panel opens.
      expect(await screen.findByRole('button', { name: 'Select primary' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Select lenovo' })).toBeInTheDocument();
      // The choice is the table itself, not a control above it.
      expect(screen.queryByLabelText('Environment')).not.toBeInTheDocument();
    });

    it('saves the choice and then works against that environment', async () => {
      const user = userEvent.setup();
      const fetchMock = unchosen();
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<AppPanel />);
      await screen.findByText('Choose an environment to continue');

      // Answering switches the panel over to the normal view.
      fetchMock.mockImplementation((input: string, init?: RequestInit) => {
        void init;
        const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0] as string;
        if (path === '/environment') {
          return Promise.resolve(
            asResponse({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ selected: 27, name: 'lenovo', persisted: true }),
            }),
          );
        }
        if (path === '/environments') {
          return Promise.resolve(
            asResponse({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  selected: 27,
                  environments: [
                    { id: 1, name: 'primary', type: 1, health: 'up', isSelected: false },
                    { id: 27, name: 'lenovo', type: 2, health: 'up', isSelected: true },
                  ],
                }),
            }),
          );
        }
        const table: Record<string, unknown> = {
          '/instances': { instances: [{ name: 'boat', isDefault: true }] },
          '/capabilities': { capabilities: { swarm: false } },
          '/control': control,
          '/containers': { containers },
        };
        return Promise.resolve(
          asResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve(table[path] ?? {}),
          }),
        );
      });

      // Waited for: the panel says "Loading…" until the tab read answers, and
      // deliberately does not draw a table before it has one.
      await user.click(await screen.findByRole('button', { name: 'Select lenovo' }));

      await waitFor(() =>
        expect(screen.queryByText('Choose an environment to continue')).not.toBeInTheDocument(),
      );
      // The tabs that had nothing to read now read against the chosen one.
      await user.click(screen.getByRole('tab', { name: 'Containers' }));
      expect(await screen.findByText('signalk_influxdb')).toBeInTheDocument();

      // Saved server-side rather than kept in the tab: the delta poller works
      // against the same client and would otherwise publish nothing.
      const sent = fetchMock.mock.calls.map((call) => `${call[1]?.method ?? 'GET'} ${call[0]}`);
      expect(sent.some((entry) => entry.startsWith('PUT') && entry.includes('/environment'))).toBe(
        true,
      );
    });

    it('keeps a refused switch on screen, where the next poll used to erase it', async () => {
      // The refusal, then a poll that succeeds against the environment the
      // operator never left. Sharing one error sink with the poll, the banner
      // vanished ten seconds later: no message, no changed selection, and
      // nothing left to say the switch had not worked.
      jest.useFakeTimers({ advanceTimers: true });
      const fetchMock = unchosen();
      fetchMock.mockImplementation((input: string, init?: RequestInit) => {
        const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0] as string;
        if (init?.method === 'PUT' && path === '/environment') {
          return Promise.resolve(
            asResponse({
              ok: false,
              status: 403,
              json: () =>
                Promise.resolve({
                  error: 'Portainer refused the environment change',
                  hint: 'the access token may not reach that environment',
                }),
            }),
          );
        }
        return unchosen()(input, init);
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

      render(<AppPanel />);
      await user.click(await screen.findByRole('button', { name: 'Select lenovo' }));

      expect(await screen.findByText(/Portainer refused the environment change/)).toBeVisible();

      // Two polls later the operator can still read why nothing moved.
      jest.advanceTimersByTime(25_000);
      await waitFor(() =>
        expect(screen.getByText(/Portainer refused the environment change/)).toBeInTheDocument(),
      );
      // And the choice is genuinely still open, rather than looking made.
      expect(screen.getByText('Choose an environment to continue')).toBeInTheDocument();
    });

    it('says out loud that it is switching, rather than only drawing it', async () => {
      const user = userEvent.setup();
      const fetchMock = unchosen();
      fetchMock.mockImplementation(((input: string, init?: RequestInit) => {
        // Never settles: the switch stays in flight so its status can be read.
        if (init?.method === 'PUT') return new Promise(() => {});
        return unchosen()(input, init);
      }) as unknown as typeof fetch);
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<AppPanel />);
      await user.click(await screen.findByRole('button', { name: 'Select lenovo' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Switching environment…');
    });

    it('takes a press anywhere on the row, not only on its button', async () => {
      const user = userEvent.setup();
      const fetchMock = unchosen();
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<AppPanel />);

      await user.click(await screen.findByText('lenovo'));

      await waitFor(() => {
        const sent = fetchMock.mock.calls.map((call) => `${call[1]?.method ?? 'GET'} ${call[0]}`);
        expect(
          sent.some((entry) => entry.startsWith('PUT') && entry.includes('/environment')),
        ).toBe(true);
      });
      // Once, not twice: the button sits inside the row that would otherwise
      // answer the same press.
      const puts = fetchMock.mock.calls.filter((call) => call[1]?.method === 'PUT');
      expect(puts).toHaveLength(1);
    });

    it('does not offer the environment already in use', async () => {
      global.fetch = unchosen(27) as unknown as typeof fetch;

      render(<AppPanel />);

      expect(await screen.findByRole('button', { name: 'Select primary' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Select lenovo' })).not.toBeInTheDocument();
      expect(screen.getByText('selected')).toBeInTheDocument();
      // And the header names it, since it is the only place that still does
      // once the operator moves off this tab.
      expect(screen.getByText('lenovo', { selector: 'span.fw-semibold' })).toBeInTheDocument();
    });

    it('stays out of the way when there is only one environment', async () => {
      global.fetch = routeFetch() as unknown as typeof fetch;

      await showContainers();
      await screen.findByText('signalk_influxdb');

      // Nothing to choose, so nothing is asked and nothing takes up header
      // space naming the only environment there is.
      expect(screen.queryByText('Choose an environment to continue')).not.toBeInTheDocument();
      expect(screen.queryByText('Environment')).not.toBeInTheDocument();
    });
  });

  it('renders containers for the default instance on load', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;

    await showContainers();

    expect(await screen.findByText('signalk_influxdb')).toBeInTheDocument();
    expect(screen.getByText('ais-logger')).toBeInTheDocument();
    // State badges, not just raw text.
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('exited')).toBeInTheDocument();
  });

  it('requests stopped containers too, so an exited one is visible', async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await showContainers();
    await screen.findByText('signalk_influxdb');

    const paths = fetchMock.mock.calls.map((call) => call[0]);
    expect(paths.some((path) => path.includes('/containers?all=true'))).toBe(true);
  });

  it('switches tab and renders that resource', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;
    const user = userEvent.setup();

    await showContainers();
    await screen.findByText('signalk_influxdb');

    await user.click(screen.getByRole('tab', { name: 'Stacks' }));

    expect(await screen.findByText('signalk')).toBeInTheDocument();
  });

  it('hides the swarm tabs when the daemon is not a swarm', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;

    await showContainers();
    await screen.findByText('signalk_influxdb');

    expect(screen.queryByRole('tab', { name: 'Services' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Nodes' })).not.toBeInTheDocument();
  });

  it('shows the swarm tabs when the daemon is a swarm member', async () => {
    global.fetch = routeFetch({}, true) as unknown as typeof fetch;

    await showContainers();

    expect(await screen.findByRole('tab', { name: 'Services' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Nodes' })).toBeInTheDocument();
  });

  it('hides the instance selector when only one instance is configured', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;

    await showContainers();
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

    await showContainers();
    await screen.findByText('signalk_influxdb');

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');

    await waitFor(() => {
      const paths = fetchMock.mock.calls.map((call) => call[0]);
      // Asserted exactly, not with includes(): a malformed
      // '?all=true?instance=shore' also "includes" the instance, and the facade
      // would quietly serve the default instance instead.
      expect(paths).toContain('/plugins/signalk-portainer/api/containers?all=true&instance=shore');
    });
  });

  it('does not let the old instance\u2019s environments land on the new one', async () => {
    // Switching instance while the first /environments read is in flight left
    // the header naming the wrong Docker host and the Environments tab
    // offering the wrong instance\u2019s ids \u2014 pressing one sends that id to the
    // instance it does not belong to.
    const release: (() => void)[] = [];
    const answer = (body: unknown) => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    const environmentsFor = (host: string) => ({
      selected: 1,
      environments: [
        { id: 1, name: `${host}-local`, type: 1, health: 'up', isSelected: true },
        { id: 2, name: `${host}-spare`, type: 2, health: 'up', isSelected: false },
      ],
    });

    global.fetch = jest.fn((input: string) => {
      const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0] as string;
      const onShore = input.includes('instance=shore');
      if (path === '/instances') {
        return Promise.resolve(
          answer({
            instances: [
              { name: 'boat', isDefault: true },
              { name: 'shore', isDefault: false },
            ],
          }),
        );
      }
      if (path === '/environments') {
        if (onShore) return Promise.resolve(answer(environmentsFor('shore')));
        // Held open: the read the operator switched away from.
        return new Promise((resolve) => {
          release.push(() => resolve(answer(environmentsFor('boat'))));
        });
      }
      if (path === '/control') return Promise.resolve(answer(control));
      if (path === '/capabilities') return Promise.resolve(answer({ capabilities: {} }));
      return Promise.resolve(answer({}));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<AppPanel />);
    await waitFor(() => expect(release.length).toBeGreaterThan(0));

    await user.selectOptions(await screen.findByLabelText('Instance'), 'shore');
    await screen.findByText('shore-spare');

    // The read that belongs to the instance nobody is looking at answers last.
    for (const settle of release) settle();
    await waitFor(() => expect(screen.getByText('shore-spare')).toBeInTheDocument());

    // Named after the wrong Docker host in the header, and offering the wrong
    // instance's ids in the table, is what this used to leave behind.
    expect(screen.queryAllByText('boat-local')).toHaveLength(0);
    expect(screen.queryAllByText('boat-spare')).toHaveLength(0);
  });

  it('stops offering what the last Portainer allowed the moment the instance changes', async () => {
    // Server-side enforcement means the worst case is a 403, but a button that
    // is offered and then refused is exactly what the panel exists to avoid.
    const answer = (body: unknown) => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    global.fetch = jest.fn((input: string) => {
      const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0] as string;
      const onShore = input.includes('instance=shore');
      if (path === '/instances') {
        return Promise.resolve(
          answer({
            instances: [
              { name: 'boat', isDefault: true },
              { name: 'shore', isDefault: false },
            ],
          }),
        );
      }
      // The new instance answers neither of the two questions that decide what
      // is on offer.
      if (onShore && (path === '/control' || path === '/capabilities')) {
        return new Promise(() => {});
      }
      if (path === '/control')
        return Promise.resolve(answer({ ...control, allowDestructive: true }));
      if (path === '/capabilities')
        return Promise.resolve(answer({ capabilities: { swarm: true } }));
      if (path === '/environments') {
        return Promise.resolve(
          answer({
            selected: 1,
            environments: [{ id: 1, name: 'local', type: 1, health: 'up', isSelected: true }],
          }),
        );
      }
      if (path === '/containers') return Promise.resolve(answer({ containers }));
      return Promise.resolve(answer({}));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    await showContainers();
    await screen.findByText('signalk_influxdb');
    const remove = () =>
      within(screen.getByRole('group', { name: 'Actions for signalk_influxdb' })).getByRole(
        'button',
        { name: 'Remove' },
      );
    expect(remove()).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('tab', { name: 'Nodes' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');

    await waitFor(() => expect(remove()).toHaveAttribute('aria-disabled', 'true'));
    expect(remove()).toHaveAccessibleDescription(expect.stringContaining('Waiting for the plugin'));
    expect(screen.queryByRole('tab', { name: 'Nodes' })).toBeNull();
  });

  it('presents the tabs as tabs, not as a row of buttons that look active', async () => {
    const user = userEvent.setup();
    global.fetch = routeFetch() as unknown as typeof fetch;

    render(<AppPanel />);
    // Waited for the tab body: the panel draws nothing under the strip until
    // the first read answers.
    await screen.findByRole('tabpanel');
    const environments = screen.getByRole('tab', { name: 'Environments' });
    const containers = screen.getByRole('tab', { name: 'Containers' });

    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(environments).toHaveAttribute('aria-selected', 'true');
    expect(containers).toHaveAttribute('aria-selected', 'false');
    // One tab stop for the strip, as a tablist has.
    expect(environments).toHaveAttribute('tabindex', '0');
    expect(containers).toHaveAttribute('tabindex', '-1');

    // The panel each tab controls says which tab it belongs to.
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', environments.id);
    expect(environments).toHaveAttribute('aria-controls', panel.id);

    // And the arrow keys move between them, carrying focus.
    environments.focus();
    await user.keyboard('{ArrowRight}');

    expect(containers).toHaveFocus();
    expect(containers).toHaveAttribute('aria-selected', 'true');
  });

  it('aborts an in-flight request when the panel unmounts', async () => {
    const signals: AbortSignal[] = [];
    global.fetch = jest.fn((input: string, init?: RequestInit) => {
      // The tab read is the one under test. Every request now carries a signal
      // — its own 30 second deadline — so which one is being watched has to be
      // said rather than assumed.
      if (init?.signal && input.includes('/containers')) signals.push(init.signal);
      if (input.includes('/instances')) {
        return Promise.resolve(
          asResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ instances: [{ name: 'boat', isDefault: true }] }),
          }),
        );
      }
      // Answered rather than stalled: the tab read is the one under test, and
      // it does not start until the environment is known.
      if (input.includes('/environments')) {
        return Promise.resolve(
          asResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ selected: 1, environments: [] }),
          }),
        );
      }
      // Never settles: stands in for a facade that has stalled.
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    const { unmount } = render(<AppPanel />);
    // Onto the tab whose read stalls: the panel lands on Environments, and
    // that read is answered above so the environment can be known at all.
    fireEvent.click(await screen.findByRole('tab', { name: 'Containers' }));
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));

    expect(signals[0]?.aborted).toBe(false);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('does not surface an aborted request as an error', async () => {
    global.fetch = jest.fn((input: string, init?: RequestInit) => {
      if (input.includes('/instances')) {
        return Promise.resolve(
          asResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ instances: [{ name: 'boat', isDefault: true }] }),
          }),
        );
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
        return Promise.resolve(
          asResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ instances: [{ name: 'boat', isDefault: true }] }),
          }),
        );
      }
      return Promise.resolve(
        asResponse({
          ok: false,
          status: 502,
          json: () =>
            Promise.resolve({
              error: 'Portainer GET /api/endpoints could not be reached',
              hint: 'check host, port and protocol',
            }),
        }),
      );
    }) as unknown as typeof fetch;

    await showContainers();

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached');
    expect(screen.getByRole('alert')).toHaveTextContent('check host, port and protocol');
  });

  it('renders an empty state rather than a bare table', async () => {
    global.fetch = routeFetch({ '/containers': { containers: [] } }) as unknown as typeof fetch;

    await showContainers();

    expect(await screen.findByText('No containers')).toBeInTheDocument();
  });

  it('keeps saying it is loading rather than claiming there is nothing there', async () => {
    // /instances answers, /environments does not. The panel used to call the
    // read finished at that point and draw an empty table — a slow link and a
    // Docker host with nothing on it look identical afterwards, and only one
    // of them is worth acting on.
    global.fetch = jest.fn((input: string) => {
      if (input.includes('/instances')) {
        return Promise.resolve(
          asResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ instances: [{ name: 'boat', isDefault: true }] }),
          }),
        );
      }
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    render(<AppPanel />);

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByText('No environments')).toBeNull();
    expect(screen.queryByText('No containers')).toBeNull();
  });

  it('renders an environments field that is not a list, instead of dying on it', async () => {
    // `?? []` stops at null and undefined; a truthy non-array walks into
    // rows.map during render, which the boundary catches and the operator
    // cannot get out of.
    global.fetch = routeFetch({
      '/environments': { selected: 1, environments: { 1: 'local' } },
    }) as unknown as typeof fetch;

    render(<AppPanel />);

    expect(await screen.findByText('No environments')).toBeInTheDocument();
    expect(screen.queryByText('The Portainer panel stopped')).toBeNull();
  });

  it('survives a /control response that is missing its fields', async () => {
    // A proxy or an older plugin build can answer with something else; the
    // panel must degrade to "no actions offered", not to a blank page.
    global.fetch = routeFetch({ '/control': {} }) as unknown as typeof fetch;

    await showContainers();

    expect(await screen.findByText('signalk_influxdb')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('AppPanel container actions', () => {
  const running = 'c1f0e2a3b4c5';
  const stopped = 'd2e1f0a9b8c7';

  /** The row of buttons belonging to one container. */
  const actionsFor = (name: string) =>
    within(screen.getByRole('group', { name: `Actions for ${name}` }));

  const requests = (mock: FetchMock) =>
    mock.mock.calls.map((call) => `${call[1]?.method ?? 'GET'} ${call[0]}`);

  it('starts a stopped container without asking, since nothing is interrupted', async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    await showContainers();
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

    await showContainers();
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

    await showContainers();
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

    await showContainers();
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

    await showContainers();
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

    await showContainers();
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

    await showContainers();
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
        return Promise.resolve(
          asResponse({
            ok: false,
            status: 403,
            json: () =>
              Promise.resolve({
                error: 'Refusing to stop the container running Signal K',
                hint: 'enable "Allow managing the Signal K container itself" if you really mean to',
              }),
          }),
        );
      }
      return routeFetch()(input);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await showContainers();
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

    await showContainers();
    await screen.findByText('signalk_influxdb');

    const stop = actionsFor('signalk_influxdb').getByRole('button', { name: 'Stop' });
    // Inert and focusable rather than `disabled`: the reason has to be
    // reachable by anyone who cannot hover, which a disabled button's tooltip
    // never is.
    expect(stop).toHaveAttribute('aria-disabled', 'true');
    expect(stop).toHaveAccessibleDescription(expect.stringContaining('Allow Signal K PUT control'));
    expect(stop).toHaveAttribute('title', expect.stringContaining('Allow Signal K PUT control'));
  });

  it('disables removal until destructive operations are enabled', async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;

    await showContainers();
    await screen.findByText('signalk_influxdb');

    const row = actionsFor('signalk_influxdb');
    expect(row.getByRole('button', { name: 'Remove' })).toHaveAttribute('aria-disabled', 'true');
    // Control is on, so the non-destructive actions stay available.
    expect(row.getByRole('button', { name: 'Stop' })).not.toHaveAttribute('aria-disabled');
    expect(row.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('marks the Signal K container and refuses to offer actions on it', async () => {
    global.fetch = routeFetch({
      '/control': { ...control, self: { ...control.self, shortId: running } },
    }) as unknown as typeof fetch;

    await showContainers();
    await screen.findByText('signalk_influxdb');

    expect(screen.getByText('Signal K')).toBeInTheDocument();
    const stop = actionsFor('signalk_influxdb').getByRole('button', { name: 'Stop' });
    expect(stop).toHaveAttribute('aria-disabled', 'true');
    expect(stop).toHaveAccessibleDescription(expect.stringContaining('running Signal K'));
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
      Promise.resolve(asResponse({ ok: true, status: 200, json: () => Promise.resolve(body) }));

    global.fetch = jest.fn((input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise((resolve) => {
          releasePost = () =>
            resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
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

    await showContainers();
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

    await showContainers();

    expect(await screen.findByText(/unable to identify which one/)).toBeInTheDocument();
  });
  it('opens the log viewer from a container row', async () => {
    global.fetch = routeFetch({
      '/containers/c1f0e2a3b4c5/logs': { lines: [{ stream: 'stdout', text: 'listening' }] },
    }) as unknown as typeof fetch;
    const user = userEvent.setup();

    await showContainers();
    await screen.findByText('signalk_influxdb');

    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    await user.click(within(row).getByRole('button', { name: 'Logs' }));

    expect(await screen.findByText('Logs — signalk_influxdb')).toBeInTheDocument();
    expect(await screen.findByText('listening')).toBeInTheDocument();
  });

  it('offers logs for a stopped container too', async () => {
    // The logs of something that exited are the reason to look at them.
    global.fetch = routeFetch() as unknown as typeof fetch;

    await showContainers();
    await screen.findByText('ais-logger');

    const row = screen.getByRole('group', { name: 'Actions for ais-logger' });
    expect(within(row).getByRole('button', { name: 'Logs' })).toBeEnabled();
  });

  it('offers a console only once the plugin says it can serve one', async () => {
    // The default /control here reports no console, which is what an older
    // Signal K server produces: the button is absent rather than disabled,
    // because there is nothing an operator could do about it.
    global.fetch = routeFetch() as unknown as typeof fetch;

    await showContainers();
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

    await showContainers();
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

    await showContainers();
    await screen.findByText('signalk_influxdb');
    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    await user.click(within(row).getByRole('button', { name: 'Console' }));
    await screen.findByText('Console — signalk_influxdb');

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');

    await waitFor(() => expect(screen.queryByText('Console — signalk_influxdb')).toBeNull());
  });

  it('does not ask the newly selected Portainer for a shell on the way out', async () => {
    // The dialog is a child, so its effect re-runs before the parent's effect
    // closes it. Without clearing first, switching instance fires an exec at a
    // Portainer that knows nothing about this container id — and would create
    // an orphan exec on the one that did.
    const fetchMock = routeFetch({
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
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    await showContainers();
    await screen.findByText('signalk_influxdb');
    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    await user.click(within(row).getByRole('button', { name: 'Console' }));
    await screen.findByText('Console — signalk_influxdb');

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');
    await waitFor(() => expect(screen.queryByText('Console — signalk_influxdb')).toBeNull());

    const strays = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/exec') && url.includes('instance=shore'));
    expect(strays).toEqual([]);
  });

  it('does not ask the newly selected Portainer for logs on the way out', async () => {
    // The same race, and the same reason: the log viewer's read is keyed on
    // the instance too.
    const fetchMock = routeFetch({
      '/instances': {
        instances: [
          { name: 'boat', isDefault: true },
          { name: 'shore', isDefault: false },
        ],
      },
      '/containers/c1f0e2a3b4c5/logs': { lines: [{ stream: 'stdout', text: 'listening' }] },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    await showContainers();
    await screen.findByText('signalk_influxdb');
    const row = screen.getByRole('group', { name: 'Actions for signalk_influxdb' });
    await user.click(within(row).getByRole('button', { name: 'Logs' }));
    await screen.findByText('Logs — signalk_influxdb');

    await user.selectOptions(screen.getByLabelText('Instance'), 'shore');
    await waitFor(() => expect(screen.queryByText('Logs — signalk_influxdb')).toBeNull());

    const strays = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/logs') && url.includes('instance=shore'));
    expect(strays).toEqual([]);
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

    await showContainers();
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
      await showContainers();
      await screen.findByText('signalk_influxdb');
      await user.click(screen.getByRole('tab', { name: 'Stacks' }));
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

      // Confirmed first: stopping a stack stops every container in it, which
      // is more than the single container the panel already refuses to stop
      // without asking.
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Stop' }));

      await waitFor(() => {
        const calls = fetchMock.mock.calls.map(
          (call) => `${String(call[1]?.method ?? 'GET')} ${String(call[0])}`,
        );
        expect(calls).toContain('POST /plugins/signalk-portainer/api/stacks/3/stop?instance=boat');
      });
      expect(await screen.findByText(/signalk: stopped/)).toBeInTheDocument();
    });

    it('sends nothing when the stop is called off', async () => {
      const fetchMock = stackFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      await user.click(within(row).getByRole('button', { name: 'Stop' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Stop signalk\?/)).toBeInTheDocument();
      // Named, and with the consequence spelled out: the mistake worth
      // catching is acting on the wrong row, which "are you sure?" never does.
      expect(within(dialog).getByText(/Every container in this stack stops/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const posts = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(posts).toHaveLength(0);
    });

    it('asks before a redeploy, which pulls and recreates every container', async () => {
      const fetchMock = stackFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for from-git' });
      await user.click(within(row).getByRole('button', { name: 'Redeploy' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Redeploy from-git\?/)).toBeInTheDocument();
      expect(within(dialog).getByText(/pulled again/)).toBeInTheDocument();
      // Nothing has been sent yet.
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);

      await user.click(within(dialog).getByRole('button', { name: 'Redeploy' }));

      await waitFor(() => {
        const calls = fetchMock.mock.calls.map(
          (call) => `${String(call[1]?.method ?? 'GET')} ${String(call[0])}`,
        );
        expect(calls).toContain(
          'POST /plugins/signalk-portainer/api/stacks/5/redeploy?instance=boat',
        );
      });
    });

    it('starts without asking, and says "started" rather than "startped"', async () => {
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

      // Starting is the one stack action whose worst case is that nothing
      // happens, exactly as it is for a container.
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(await screen.findByText(/signalk: started/)).toBeInTheDocument();
    });

    it('asks before deleting, and offers no volume option Portainer cannot honour', async () => {
      const fetchMock = stackFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      await user.click(within(row).getByRole('button', { name: 'Delete' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Delete signalk?')).toBeInTheDocument();
      // Portainer CE cannot remove a stack's volumes, so the dialog says so
      // rather than offering a checkbox that would do nothing.
      expect(within(dialog).queryByRole('checkbox')).toBeNull();
      expect(within(dialog).getByText(/volumes are left in place/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        const calls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(calls.some((path) => path.includes('/stacks/3?instance=boat'))).toBe(true);
        expect(calls.some((path) => path.includes('removeVolumes'))).toBe(false);
      });
    });

    it('disables the destructive button when the configuration does not allow it', async () => {
      global.fetch = stackFetch({ '/control': control }) as unknown as typeof fetch;
      const user = userEvent.setup();
      await openStacks(user);

      const row = screen.getByRole('group', { name: 'Actions for signalk' });
      const remove = within(row).getByRole('button', { name: 'Delete' });
      expect(remove).toHaveAttribute('aria-disabled', 'true');
      expect(remove).toHaveAccessibleDescription(expect.stringContaining('destructive'));
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
        expect(jsonBody<{ content: string }>(put).content).toContain('web:');
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
        expect(jsonBody<{ name: string }>(post).name).toBe('weather');
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

      expect(screen.getByRole('button', { name: 'New stack' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });

  /**
   * The one inventory the panel will change.
   *
   * These cover the two decisions that are not obvious from the code: that the
   * disk-usage read is deliberately kept off the ten-second poll, and that the
   * wide prune is never sent unless the operator asked for it.
   */
  describe('images', () => {
    const held = 'sha256:aaaa1111bbbb2222';
    const loose = 'sha256:cccc3333dddd4444';

    const images = [
      { Id: held, RepoTags: ['influxdb:2.7'], Created: 1_755_000_000, Size: 412_000_000 },
      { Id: loose, RepoTags: [], Created: 1_754_000_000, Size: 90_000_000 },
    ];

    /**
     * What `docker system df` says about those two: one held by a container,
     * one held by nothing, and 502 MB of layers between them.
     */
    const df = {
      LayersSize: 502_000_000,
      Images: [
        { Id: held, Created: 1, Size: 412_000_000, SharedSize: 0, Containers: 1 },
        { Id: loose, Created: 1, Size: 90_000_000, SharedSize: 0, Containers: 0 },
      ],
    };

    const imageFetch = (overrides: Record<string, unknown> = {}) =>
      routeFetch({
        '/images': { images },
        '/df': { df },
        '/control': { ...control, allowDestructive: true },
        ...overrides,
      });

    const openImages = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
      render(<AppPanel />);
      await user.click(await screen.findByRole('tab', { name: 'Images' }));
      await screen.findByText('influxdb:2.7');
    };

    it('reports what the images cost, using Docker’s arithmetic rather than a sum of the rows', async () => {
      global.fetch = imageFetch() as unknown as typeof fetch;
      const user = userEvent.setup();

      await openImages(user);

      // 90 MB, not the 502 MB the two row sizes add up to: the held image's
      // layers are not going anywhere.
      expect(
        await screen.findByText(/2 images · 502 MB on disk · 90 MB reclaimable/),
      ).toBeInTheDocument();
    });

    it('keeps the disk-usage read off the ten-second poll', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      const fetchMock = imageFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

      await openImages(user);

      // Inside act: the poll this releases sets state as it lands, and left
      // outside it those updates arrive after the test has finished.
      await act(async () => {
        jest.advanceTimersByTime(30_000);
        // The interval fires synchronously; its fetch settles as a microtask,
        // and flushing here is what puts the state updates inside this act.
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(
          requests(fetchMock).filter((entry) => entry.includes('/images')).length,
        ).toBeGreaterThan(1);
      });
      // /system/df walks the layer store, which on the SD card of a Pi is
      // seconds of work. Once when the tab opened is the whole of it.
      expect(requests(fetchMock).filter((entry) => entry.includes('/df')).length).toBe(1);
    });

    it('deletes by id, then re-reads both the list and the usage', async () => {
      const fetchMock = imageFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();

      await openImages(user);
      await user.click(
        within(screen.getByRole('group', { name: 'Actions for influxdb:2.7' })).getByRole(
          'button',
          { name: 'Delete' },
        ),
      );

      const dialog = await screen.findByRole('dialog');
      // It names the image rather than asking "are you sure?": the mistake
      // worth catching is acting on the wrong row.
      expect(within(dialog).getByText(/Delete influxdb:2.7\?/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(requests(fetchMock)).toContain(
          `DELETE /plugins/signalk-portainer/api/images/${encodeURIComponent(held)}?instance=boat`,
        );
      });
      // The summary is the answer to what the delete did, so it is re-read too.
      await waitFor(() =>
        expect(requests(fetchMock).filter((entry) => entry.includes('/df')).length).toBe(2),
      );
    });

    it('says a container is holding the image rather than hiding the button', async () => {
      global.fetch = imageFetch() as unknown as typeof fetch;
      const user = userEvent.setup();

      await openImages(user);
      await user.click(
        within(screen.getByRole('group', { name: 'Actions for influxdb:2.7' })).getByRole(
          'button',
          { name: 'Delete' },
        ),
      );

      // Docker decides at the moment of the request; this reading is from when
      // the tab opened, so it explains rather than refuses.
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/1 container is using it/)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
    });

    it('prunes untagged layers unless the operator widens it', async () => {
      const fetchMock = imageFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();

      await openImages(user);
      await user.click(screen.getByRole('button', { name: 'Reclaim space' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/90 MB reclaimable/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Delete untagged layers' }));

      await waitFor(() => {
        expect(requests(fetchMock)).toContain(
          'POST /plugins/signalk-portainer/api/images/prune?all=false&instance=boat',
        );
      });
    });

    it('widens the prune only when the box is ticked', async () => {
      const fetchMock = imageFetch();
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();

      await openImages(user);
      await user.click(screen.getByRole('button', { name: 'Reclaim space' }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByLabelText(/tagged images no container is using/));
      // The warning about needing a connection to get one back appears with it.
      expect(within(dialog).getByText(/needs a working connection/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Delete unused images' }));

      await waitFor(() => {
        expect(requests(fetchMock)).toContain(
          'POST /plugins/signalk-portainer/api/images/prune?all=true&instance=boat',
        );
      });
    });

    it('does not let the tab’s slower usage read undo what a prune reported', async () => {
      // The two /df reads land in the order Docker answers them, not the order
      // they were asked for: the one the tab opened with can still be in
      // flight when the prune's answer arrives, and it is an account of the
      // disk from before the prune ran. Applied on top, the freed space
      // reappears in the summary and the operator is told the prune did
      // nothing.
      const pending: Array<(body: unknown) => void> = [];
      const afterPrune = {
        LayersSize: 412_000_000,
        Images: [{ Id: held, Created: 1, Size: 412_000_000, SharedSize: 0, Containers: 1 }],
      };
      const base = imageFetch();
      const fetchMock = jest.fn((input: string, init?: RequestInit) => {
        const path = input.replace('/plugins/signalk-portainer/api', '').split('?')[0];
        // Held rather than answered, so the test decides the order.
        if (path === '/df') {
          return new Promise<Response>((resolve) => {
            // Wrapped as the panel reads it: /df answers with the figures
            // under a `df` key, not as the body itself.
            pending.push((body) =>
              resolve(
                asResponse({ ok: true, status: 200, json: () => Promise.resolve({ df: body }) }),
              ),
            );
          });
        }
        return base(input, init);
      }) as FetchMock;
      global.fetch = fetchMock as unknown as typeof fetch;
      const user = userEvent.setup();

      await openImages(user);
      await user.click(screen.getByRole('button', { name: 'Reclaim space' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete untagged layers' }));

      // The prune's own read of the disk, made after it finished.
      await waitFor(() => expect(pending).toHaveLength(2));
      await act(async () => {
        pending[1]?.(afterPrune);
        await Promise.resolve();
      });
      expect(await screen.findByText(/412 MB on disk/)).toBeInTheDocument();

      // And now the read from before the prune, arriving last.
      await act(async () => {
        pending[0]?.(df);
        await Promise.resolve();
      });

      expect(screen.getByText(/412 MB on disk/)).toBeInTheDocument();
      expect(screen.queryByText(/502 MB on disk/)).not.toBeInTheDocument();
      expect(screen.queryByText(/90 MB reclaimable/)).not.toBeInTheDocument();
    });

    it('offers neither action until destructive operations are enabled', async () => {
      global.fetch = imageFetch({ '/control': control }) as unknown as typeof fetch;
      const user = userEvent.setup();

      await openImages(user);

      expect(screen.getByRole('button', { name: 'Reclaim space' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      const row = within(screen.getByRole('group', { name: 'Actions for influxdb:2.7' }));
      expect(row.getByRole('button', { name: 'Delete' })).toHaveAccessibleDescription(
        /Destructive operations are disabled/,
      );
    });
  });
});
