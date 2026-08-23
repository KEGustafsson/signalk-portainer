/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../src/webapp/api';
import { StackEditor, type StackDeployment } from '../../src/webapp/StackEditor';
import type { Stack } from '../../src/types';

const fileStack: Stack = {
  Id: 3,
  Name: 'signalk',
  Type: 2,
  EndpointId: 1,
  Status: 1,
  Env: [{ name: 'TZ', value: 'Europe/Helsinki' }],
};

const gitStack: Stack = {
  ...fileStack,
  Id: 5,
  Name: 'from-git',
  GitConfig: { URL: 'https://example.test/boat/stacks', ReferenceName: 'refs/heads/main' },
};

const withFile = (content = 'services:\n  influxdb:\n') =>
  jest.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ content }) }));

const renderEditor = (
  props: Partial<React.ComponentProps<typeof StackEditor>> & { fetch?: typeof global.fetch } = {},
): { onDeploy: jest.Mock; onClose: jest.Mock } => {
  const { fetch: fetchOverride, ...rest } = props;
  if (fetchOverride) global.fetch = fetchOverride;
  const onDeploy = jest.fn();
  const onClose = jest.fn();
  render(
    <StackEditor
      target={{ kind: 'existing', stack: fileStack }}
      instance="boat"
      canDeploy
      busy={false}
      onDeploy={onDeploy}
      onClose={onClose}
      {...rest}
    />,
  );
  return { onDeploy, onClose };
};

describe('StackEditor', () => {
  beforeEach(() => {
    global.fetch = withFile() as unknown as typeof fetch;
  });

  it('loads the compose file and the environment the stack was deployed with', async () => {
    renderEditor();

    await waitFor(() =>
      expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
    );
    expect(screen.getByLabelText('Variable 1 name')).toHaveValue('TZ');
    expect(screen.getByLabelText('Variable 1 value')).toHaveValue('Europe/Helsinki');
  });

  it('asks the selected instance for the file', async () => {
    const fetchMock = global.fetch as unknown as jest.Mock;
    renderEditor();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/stacks/3/file?instance=boat');
  });

  it('will not deploy until something has changed', async () => {
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() =>
      expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
    );

    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled();

    await user.type(screen.getByLabelText('Compose file'), '  web:\n');

    expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled();
  });

  it('sends the file, the environment and the deploy options', async () => {
    const user = userEvent.setup();
    const { onDeploy } = renderEditor();
    await waitFor(() =>
      expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
    );

    await user.clear(screen.getByLabelText('Variable 1 value'));
    await user.type(screen.getByLabelText('Variable 1 value'), 'UTC');
    await user.click(screen.getByLabelText('Remove services no longer in the file'));
    await user.click(screen.getByRole('button', { name: 'Deploy' }));

    const deployment = onDeploy.mock.calls[0]?.[0] as StackDeployment;
    expect(deployment.content).toBe('services:\n  influxdb:\n');
    expect(deployment.env).toEqual([{ name: 'TZ', value: 'UTC' }]);
    expect(deployment.prune).toBe(true);
    expect(deployment.pullImage).toBe(false);
  });

  it('drops a variable the operator removed', async () => {
    const user = userEvent.setup();
    const { onDeploy } = renderEditor();
    await waitFor(() =>
      expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
    );

    await user.click(screen.getByRole('button', { name: 'Remove TZ' }));
    await user.click(screen.getByRole('button', { name: 'Deploy' }));

    expect((onDeploy.mock.calls[0]?.[0] as StackDeployment).env).toEqual([]);
  });

  it('shows a git-backed stack read-only, and offers no deploy at all', async () => {
    renderEditor({ target: { kind: 'existing', stack: gitStack } });

    await waitFor(() =>
      expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
    );
    // Deploying a file over it would detach it from the repository; the server
    // refuses that, and an editable box ending in a refusal says it worse.
    expect(screen.getByLabelText('Compose file')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Deploy' })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be edited here/)).toBeInTheDocument();
  });

  it('is read-only when the configuration does not allow writes', async () => {
    renderEditor({ canDeploy: false });

    await waitFor(() =>
      expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
    );
    expect(screen.getByLabelText('Compose file')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled();
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
  });

  it('reports a file that could not be read', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Stack 3 does not belong to this environment' }),
      }),
    ) as unknown as typeof fetch;

    renderEditor();

    expect(await screen.findByText(/does not belong to this environment/)).toBeInTheDocument();
  });

  describe('when the compose file could not be read', () => {
    const unreadable = () =>
      jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: async () => ({ error: 'Portainer could not be reached' }),
        }),
      ) as unknown as typeof fetch;

    it('will not deploy an empty box over the stack that is running', async () => {
      // The read failing leaves the editor holding an empty file it never got.
      // Editable and deployable, the first keystroke counted as a change and
      // Deploy PUT that fragment over the stack's real compose file —
      // replacing it, with nothing left to recover it from.
      const user = userEvent.setup();
      const { onDeploy } = renderEditor({ fetch: unreadable() });
      await screen.findByText('Portainer could not be reached');

      const file = screen.getByLabelText('Compose file');
      expect(file).toHaveAttribute('readonly');
      await user.type(file, 'services:\n  anything:\n');

      expect(file).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled();
      expect(onDeploy).not.toHaveBeenCalled();
    });

    it('says why the box is empty, since an empty box says nothing', async () => {
      renderEditor({ fetch: unreadable() });

      const banner = await screen.findByRole('alert');
      expect(banner).toHaveTextContent('Portainer could not be reached');
      expect(banner).toHaveTextContent(/could not be read/);
      expect(banner).toHaveTextContent(/deploying now would replace the file/i);
    });

    it('locks the environment rows too, since they deploy with the file', async () => {
      renderEditor({ fetch: unreadable() });
      await screen.findByText('Portainer could not be reached');

      expect(screen.getByLabelText('Variable 1 name')).toHaveAttribute('readonly');
      expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    });
  });

  describe('environment variables', () => {
    const twoVars: Stack = {
      ...fileStack,
      Env: [
        { name: 'ALPHA', value: 'one' },
        { name: 'BETA', value: 'two' },
      ],
    };

    it('keeps each row with its own variable when one above it is removed', async () => {
      // Keyed by position, React reused the node that held ALPHA for BETA:
      // focus and caret stayed put while the value under them changed, and the
      // operator carried on typing into a different variable than the one they
      // meant.
      const user = userEvent.setup();
      renderEditor({ target: { kind: 'existing', stack: twoVars } });
      await waitFor(() =>
        expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
      );

      const beta = screen.getByLabelText('Variable 2 value');
      await user.click(screen.getByRole('button', { name: 'Remove ALPHA' }));

      // BETA is now the only row, and it is the row it always was: the very
      // same element, still holding its own value. Identity is the point —
      // whatever the operator had in that node, caret and focus included,
      // stays with the variable it belongs to.
      expect(screen.getByLabelText('Variable 1 name')).toHaveValue('BETA');
      expect(screen.getByLabelText('Variable 1 value')).toBe(beta);
      expect(beta).toHaveValue('two');
    });

    it('names the group rather than leaving a label pointing at nothing', async () => {
      // A <label> wrapping no control and carrying no htmlFor is invalid HTML,
      // inert to clicks, and names none of the fields under it.
      renderEditor();
      await screen.findByLabelText('Variable 1 name');

      expect(screen.getByRole('group', { name: 'Environment variables' })).toBeInTheDocument();
    });
  });

  describe('closing over unsaved work', () => {
    it('asks before throwing away an edited file', async () => {
      // The deploy path keeps the editor open when a deploy fails, because
      // closing would throw away work an error asked the operator to redo.
      // Close threw the same work away without a word.
      const user = userEvent.setup();
      const { onClose } = renderEditor();
      await waitFor(() =>
        expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
      );
      await user.type(screen.getByLabelText('Compose file'), '  web:\n');

      await user.click(screen.getByRole('button', { name: 'Close' }));

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText(/Close without deploying/)).toBeInTheDocument();
      // On the answer that keeps the work, so a stray Enter is harmless.
      expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();

      await user.click(screen.getByRole('button', { name: 'Discard' }));
      expect(onClose).toHaveBeenCalled();
    });

    it('goes back to the file when the operator changes their mind', async () => {
      const user = userEvent.setup();
      const { onClose } = renderEditor();
      await waitFor(() =>
        expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
      );
      await user.type(screen.getByLabelText('Compose file'), '  web:\n');
      await user.click(screen.getByRole('button', { name: 'Close' }));

      await user.click(screen.getByRole('button', { name: 'Keep editing' }));

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n  web:\n');
    });

    it('closes without asking when nothing has been touched', async () => {
      const user = userEvent.setup();
      const { onClose } = renderEditor();
      await waitFor(() =>
        expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
      );

      await user.click(screen.getByRole('button', { name: 'Close' }));

      expect(onClose).toHaveBeenCalled();
    });

    it('does not let Escape be the key that discards the file', async () => {
      const user = userEvent.setup();
      const { onClose } = renderEditor();
      await waitFor(() =>
        expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
      );
      await user.type(screen.getByLabelText('Compose file'), '  web:\n');

      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText(/Close without deploying/)).toBeInTheDocument();

      // A second Escape backs out of the question rather than answering it.
      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByText(/Close without deploying/)).toBeNull();
    });
  });

  describe('focus', () => {
    it('gives focus back to whatever opened it', async () => {
      // Without this, closing drops focus on <body> and the next Tab starts at
      // the top of the Signal K admin UI rather than at the row the operator
      // pressed Edit on.
      const user = userEvent.setup();
      const opener = document.createElement('button');
      opener.textContent = 'Edit';
      document.body.append(opener);
      opener.focus();

      const { unmount } = render(
        <StackEditor
          target={{ kind: 'existing', stack: fileStack }}
          instance="boat"
          canDeploy
          busy={false}
          onDeploy={jest.fn()}
          onClose={jest.fn()}
        />,
      );
      await waitFor(() =>
        expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
      );
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

      unmount();

      expect(opener).toHaveFocus();
      opener.remove();
      void user;
    });

    it('keeps Tab inside the dialog rather than letting it walk out behind the scrim', async () => {
      // aria-modal traps nothing on its own, and the admin UI is right there
      // underneath: without a cycle, Tab leaves the dialog and the operator is
      // moving through controls they cannot see.
      const user = userEvent.setup();
      renderEditor();
      await waitFor(() =>
        expect(screen.getByLabelText('Compose file')).toHaveValue('services:\n  influxdb:\n'),
      );

      const dialog = screen.getByRole('dialog');
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
        ),
      );
      const last = focusable[focusable.length - 1];
      last?.focus();

      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(focusable[0]);

      await user.tab({ shift: true });
      expect(document.activeElement).toBe(last);
    });
  });

  it('keeps a failed deploy on screen without throwing the file away', async () => {
    renderEditor({
      result: { ok: false, error: new ApiError(400, 'Stack is deployed from a repository') },
    });

    expect(await screen.findByText('Stack is deployed from a repository')).toBeInTheDocument();
    // The editor is still here, still holding what was typed.
    expect(screen.getByLabelText('Compose file')).toBeInTheDocument();
  });

  describe('creating', () => {
    const renderNew = () => renderEditor({ target: { kind: 'new' } });

    it('needs a name Docker would accept before it will create', async () => {
      const user = userEvent.setup();
      renderNew();

      await user.type(screen.getByLabelText('Compose file'), 'services:\n');
      // A file is not enough on its own: the stack still needs a name.
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

      await user.type(screen.getByLabelText('Name'), 'weather');
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();

      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), '../etc');

      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
      expect(screen.getByText(/only letters, digits/)).toBeInTheDocument();
    });

    it('creates from a compose file', async () => {
      const user = userEvent.setup();
      const { onDeploy } = renderNew();

      await user.type(screen.getByLabelText('Name'), 'weather');
      await user.type(screen.getByLabelText('Compose file'), 'services:\n');
      await user.click(screen.getByRole('button', { name: 'Create' }));

      const deployment = onDeploy.mock.calls[0]?.[0] as StackDeployment;
      expect(deployment.name).toBe('weather');
      expect(deployment.content).toBe('services:\n');
      expect(deployment.repositoryUrl).toBeUndefined();
    });

    it('creates from a repository, with the fields that belong to one', async () => {
      const user = userEvent.setup();
      const { onDeploy } = renderNew();

      await user.type(screen.getByLabelText('Name'), 'weather');
      await user.selectOptions(screen.getByLabelText('From'), 'repository');
      await user.type(screen.getByLabelText('Repository URL'), 'https://example.test/boat/stacks');
      await user.type(screen.getByLabelText('Reference'), 'refs/heads/main');
      await user.click(screen.getByRole('button', { name: 'Create' }));

      const deployment = onDeploy.mock.calls[0]?.[0] as StackDeployment;
      expect(deployment.repositoryUrl).toBe('https://example.test/boat/stacks');
      expect(deployment.reference).toBe('refs/heads/main');
      expect(deployment.content).toBeUndefined();
      // No file was read: a new stack has none.
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends a token given without a username', async () => {
      // Several git hosts take the token in the password field and ignore the
      // username; dropping it would clone anonymously and fail.
      const user = userEvent.setup();
      const { onDeploy } = renderNew();

      await user.type(screen.getByLabelText('Name'), 'weather');
      await user.selectOptions(screen.getByLabelText('From'), 'repository');
      await user.type(screen.getByLabelText('Repository URL'), 'https://example.test/boat/stacks');
      await user.type(screen.getByLabelText('Password or token'), 'ghp_secret');
      await user.click(screen.getByRole('button', { name: 'Create' }));

      const deployment = onDeploy.mock.calls[0]?.[0] as StackDeployment;
      expect(deployment.password).toBe('ghp_secret');
      expect(deployment.username).toBeUndefined();
    });

    it('will not create from a repository with no URL', async () => {
      const user = userEvent.setup();
      renderNew();

      await user.type(screen.getByLabelText('Name'), 'weather');
      await user.selectOptions(screen.getByLabelText('From'), 'repository');

      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    });
  });

  it('closes on Escape, but not while a deploy is in flight', async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor({ busy: true });

    await user.keyboard('{Escape}');
    // Closing would not stop the deploy; it would only hide it.
    expect(onClose).not.toHaveBeenCalled();
  });
});
