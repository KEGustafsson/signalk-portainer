/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DockerContainer } from '../../src/types';
import { ConfirmDialog } from '../../src/webapp/ConfirmDialog';

const container = (overrides: Partial<DockerContainer> = {}): DockerContainer =>
  ({
    Id: 'c1f0e2a3b4c5d6e7',
    Names: ['/influx'],
    Image: 'influxdb:2.7',
    State: 'running',
    Status: 'Up 1 hour',
    Created: 0,
    ...overrides,
  }) as DockerContainer;

describe('ConfirmDialog', () => {
  it('names the container and what the action does to it', () => {
    render(
      <ConfirmDialog
        request={{ container: container(), action: 'kill' }}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText('Kill influx?')).toBeInTheDocument();
    expect(screen.getByText(/SIGKILL/)).toBeInTheDocument();
    // The id is shown too: two containers can carry confusingly similar names.
    expect(screen.getByText('(c1f0e2a3b4c5)')).toBeInTheDocument();
  });

  it('puts focus on Cancel, so a stray Enter does nothing', () => {
    render(
      <ConfirmDialog
        request={{ container: container(), action: 'stop' }}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('cancels on Escape', async () => {
    const onCancel = jest.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        request={{ container: container(), action: 'stop' }}
        busy={false}
        onCancel={onCancel}
        onConfirm={() => {}}
      />,
    );

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalled();
  });

  it('passes both removal options as chosen', async () => {
    const onConfirm = jest.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        request={{ container: container(), action: 'remove' }}
        busy={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByLabelText(/^Force/));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onConfirm).toHaveBeenCalledWith({ force: true, removeVolumes: false });
  });

  it('locks both buttons while the request is in flight', () => {
    render(
      <ConfirmDialog
        request={{ container: container(), action: 'stop' }}
        busy
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
  });
});
