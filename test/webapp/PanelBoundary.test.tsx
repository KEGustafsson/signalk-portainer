/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ReactElement } from 'react';
import { PanelBoundary } from '../../src/webapp/PanelBoundary';

describe('PanelBoundary', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    // React logs the caught error itself; silencing keeps the run readable.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  const Boom = (): never => {
    throw new Error('rows.map is not a function');
  };

  it('renders its children when nothing is wrong', () => {
    render(
      <PanelBoundary>
        <p>the panel</p>
      </PanelBoundary>,
    );

    expect(screen.getByText('the panel')).toBeInTheDocument();
  });

  it('keeps a render failure inside the panel', () => {
    // The panel is a remote inside the Signal K admin UI's own React tree.
    // Without a boundary, React unmounts that whole tree — the operator loses
    // the admin UI, not just this tab.
    expect(() =>
      render(
        <PanelBoundary>
          <Boom />
        </PanelBoundary>,
      ),
    ).not.toThrow();

    expect(screen.getByRole('alert')).toHaveTextContent('The Portainer panel stopped');
  });

  it('says what failed, and offers a way back', () => {
    render(
      <PanelBoundary>
        <Boom />
      </PanelBoundary>,
    );

    expect(screen.getByText('rows.map is not a function')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('mounts the panel afresh when Try again is pressed', async () => {
    // "Try again" has to be a new subtree — new state, and every read run
    // again — rather than another render of the thing that threw. Keyed on the
    // attempt, React is made to build one.
    const user = userEvent.setup();
    let mounts = 0;
    let broken = true;
    const Fragile = (): ReactElement => {
      useEffect(() => {
        mounts += 1;
      }, []);
      if (broken) throw new Error('rows.map is not a function');
      return <p>the panel</p>;
    };

    render(
      <PanelBoundary>
        <Fragile />
      </PanelBoundary>,
    );
    // The render that threw never committed, so nothing was ever mounted.
    expect(mounts).toBe(0);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();

    broken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(mounts).toBe(1);
    expect(screen.getByText('the panel')).toBeInTheDocument();
    expect(screen.queryByText('The Portainer panel stopped')).toBeNull();
  });

  it('reports the failure where someone debugging would look', () => {
    render(
      <PanelBoundary>
        <Boom />
      </PanelBoundary>,
    );

    const reported = consoleError.mock.calls.some((call) =>
      String(call[0]).includes('signalk-portainer panel failed'),
    );
    expect(reported).toBe(true);
  });
});
