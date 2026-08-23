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

  it('still closes on Escape while the request is in flight', async () => {
    const onCancel = jest.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        request={{ container: container(), action: 'stop' }}
        busy
        onCancel={onCancel}
        onConfirm={() => {}}
      />,
    );

    await user.keyboard('{Escape}');

    // Closing does not stop what was already sent — but a link that drops
    // rather than resets leaves the request hanging for minutes, and a dialog
    // with no way out is worse than one the operator dismissed knowingly.
    expect(onCancel).toHaveBeenCalled();
  });

  it('will not submit a removal Docker would refuse', async () => {
    const onConfirm = jest.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        request={{ container: container({ State: 'running' }), action: 'remove' }}
        busy={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    // The dialog says force is required, so it does not offer to send without.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();

    await user.click(screen.getByLabelText(/^Force/));

    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });

  it('asks for force on a paused container too, which Docker also refuses', () => {
    render(
      <ConfirmDialog
        request={{ container: container({ State: 'paused' }), action: 'remove' }}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByLabelText(/the container is paused/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('locks the action but never the way out, while the request is in flight', () => {
    render(
      <ConfirmDialog
        request={{ container: container(), action: 'stop' }}
        busy
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    // The action is locked so it cannot be sent twice; the dismiss button
    // stays live, and says Close rather than Cancel because it no longer
    // cancels anything.
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });
});
