import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps a failure inside the panel.
 *
 * This panel is a Module Federation remote rendered inside the Signal K admin
 * UI's own React tree. React unmounts the whole tree when a render throws and
 * nothing catches it — so without this, a bug here does not break the Portainer
 * tab, it breaks the admin UI, and the operator has to reload the page to get
 * their server back. A boundary is the only thing that stops that, and it has
 * to be a class: there is no hook equivalent.
 */
export class PanelBoundary extends Component<
  { children: ReactNode },
  { failed: Error | undefined; attempt: number }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: undefined, attempt: 0 };
  }

  static getDerivedStateFromError(error: Error): { failed: Error } {
    return { failed: error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The admin UI's console is where someone debugging this will look.
    console.error('signalk-portainer panel failed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { failed, attempt } = this.state;
    // Keyed on the attempt so "Try again" actually tries again: clearing the
    // flag alone re-renders the same component instance holding the same state
    // that threw, which throws again on the spot and leaves a panel that
    // cannot be recovered from without reloading the admin UI. A changed key
    // makes React unmount the subtree and mount a fresh one, which reads from
    // the facade again from nothing.
    if (!failed) return <Fragment key={attempt}>{this.props.children}</Fragment>;

    return (
      <div className="alert alert-danger m-3" role="alert">
        <h5 className="alert-heading">The Portainer panel stopped</h5>
        <p className="mb-2">
          Something in this panel failed while drawing. The rest of the Signal K admin UI is
          unaffected — try again below, or reload the page.
        </p>
        <p className="small mb-2 text-muted">{failed.message}</p>
        <button
          type="button"
          className="btn btn-sm btn-outline-danger"
          onClick={() =>
            this.setState((current) => ({ failed: undefined, attempt: current.attempt + 1 }))
          }
        >
          Try again
        </button>
      </div>
    );
  }
}
