/**
 * Short-lived tickets that carry an authorisation from a REST call to a
 * WebSocket upgrade.
 *
 * The problem this solves: Signal K authenticates the plugin's REST routes —
 * they require an admin session unless the plugin opens them up — but
 * `registerWebSocket` hands the plugin a raw upgrade and says authentication is
 * its own responsibility. The upgrade does carry the session cookie, and
 * trusting it would be a mistake: WebSocket upgrades are not subject to CORS,
 * so any page the operator visits can open one to their own server and have the
 * browser attach the cookie. A cookie proves the browser has a session, not
 * that this page was allowed to ask for a shell.
 *
 * So the decision is made where it can be made properly. An authenticated POST
 * asks for a shell, and gets back a ticket: a random, single-use, short-lived
 * string bound to exactly the exec instance it was minted for. The socket then
 * presents the ticket, and can reach nothing else.
 */

import { randomBytes } from 'node:crypto';

/** What a ticket authorises: one exec instance, on one Portainer. */
export interface ExecGrant {
  instance: string | undefined;
  /** Docker's exec instance id, already created and not yet started. */
  execId: string;
  /** The container it runs in, for the audit line and the refusal message. */
  containerId: string;
}

/**
 * Long enough to survive an operator's browser opening a socket, short enough
 * that a ticket in a proxy log is worthless by the time anyone reads it.
 */
const DEFAULT_TTL_MS = 30_000;

/**
 * A ceiling on unredeemed tickets, so a caller minting them in a loop cannot
 * grow this without bound. Well above any real use: a ticket lives 30 seconds
 * and is consumed by the socket that follows it.
 */
const MAX_OUTSTANDING = 32;

export class ExecTicketError extends Error {
  readonly status = 429;
  readonly hint =
    'a shell was asked for many times without being opened; wait a moment and try again';

  constructor() {
    super('Too many console sessions are being opened at once');
    this.name = 'ExecTicketError';
  }
}

/** A held place in the store, filled in once there is a shell to point at. */
export interface ExecReservation {
  /** Fills the reservation and returns the ticket that redeems it. */
  commit(grant: ExecGrant): string;
  /** Gives the place back, for a shell that never came to exist. */
  release(): void;
}

export class ExecTickets {
  private readonly issued = new Map<string, { grant?: ExecGrant; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly random: () => string = () => randomBytes(32).toString('hex'),
  ) {}

  /** A ticket for this grant. Valid once, and only for a moment. */
  mint(grant: ExecGrant): string {
    return this.reserve().commit(grant);
  }

  /**
   * Takes a place in the queue before there is anything to put in it.
   *
   * The order matters: creating the exec instance and then finding there is no
   * room for its ticket leaves an exec in Docker that nothing can ever start,
   * and a caller retrying accumulates them. Reserving first means a full store
   * is refused before anything is created.
   */
  reserve(): ExecReservation {
    this.expire();
    if (this.issued.size >= MAX_OUTSTANDING) throw new ExecTicketError();
    const placeholder = this.random();
    this.issued.set(placeholder, { expiresAt: this.now() + this.ttlMs });
    let settled = false;

    return {
      commit: (grant: ExecGrant): string => {
        if (settled) throw new Error('this reservation has already been settled');
        settled = true;
        // The place is already held; filling it in is what makes it usable.
        this.issued.set(placeholder, { grant, expiresAt: this.now() + this.ttlMs });
        return placeholder;
      },
      release: (): void => {
        if (settled) return;
        settled = true;
        this.issued.delete(placeholder);
      },
    };
  }

  /**
   * The grant behind a ticket, if it is one — and never twice.
   *
   * Consumed rather than checked: a ticket that could be replayed would let a
   * page that saw one open a second shell after the first was closed.
   */
  consume(ticket: string | undefined): ExecGrant | undefined {
    if (!ticket) return undefined;
    this.expire();
    const held = this.issued.get(ticket);
    // A reservation that has not been committed holds a place and nothing
    // else: there is no shell behind it yet.
    if (!held?.grant) return undefined;
    this.issued.delete(ticket);
    return held.grant;
  }

  /** How many tickets are outstanding; for tests and for the health report. */
  get outstanding(): number {
    this.expire();
    return this.issued.size;
  }

  /** Drops every ticket. The plugin stopping invalidates all of them. */
  clear(): void {
    this.issued.clear();
  }

  private expire(): void {
    const now = this.now();
    for (const [ticket, held] of this.issued) {
      if (held.expiresAt <= now) this.issued.delete(ticket);
    }
  }
}
