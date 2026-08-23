/**
 * The consoles that are currently open, so their terminals can be resized.
 *
 * A shell started at Docker's default 80x24 renders `top` and `vi` into the
 * wrong shape for the rest of its life, and the browser is the only end that
 * knows how big the terminal actually is. It cannot say so over the socket —
 * that is a byte pipe to the shell, and a control message in it would be
 * indistinguishable from something the operator typed — so it says so over the
 * REST surface it is already authenticated on.
 *
 * What it needs to name the shell is a handle. The ticket will not do: it is
 * consumed by the upgrade and it travels in a URL query, where a proxy log
 * keeps it. So the POST that mints the ticket also mints a session id, returned
 * in the body and never put in a URL, and this is where the socket records what
 * that id refers to.
 */

/** One open console, as much of it as a resize needs. */
export interface ConsoleSession {
  instance: string | undefined;
  /** Docker's exec instance id — never sent to the browser. */
  execId: string;
  containerId: string;
}

export class ConsoleSessions {
  private readonly open = new Map<string, ConsoleSession>();

  /**
   * Records a console that has just opened.
   *
   * Unbounded on purpose: the only caller holds a permit from the console's
   * own limiter, so the ceiling on open shells is the ceiling on this too.
   */
  add(id: string, session: ConsoleSession): void {
    this.open.set(id, session);
  }

  get(id: string | undefined): ConsoleSession | undefined {
    return id ? this.open.get(id) : undefined;
  }

  /** Forgets a console that has ended. Resizing it would reach nothing. */
  remove(id: string): void {
    this.open.delete(id);
  }

  clear(): void {
    this.open.clear();
  }

  /** How many consoles are open; for tests and for the health report. */
  get size(): number {
    return this.open.size;
  }
}
