import { ExecTickets, ExecTicketError } from '../src/exectickets';

describe('ExecTickets', () => {
  const grant = (execId = 'exec-1') => ({
    instance: 'boat',
    execId,
    containerId: 'c1f0e2a3b4c5d6e7',
  });

  /** A clock and a counter, so expiry and uniqueness are assertions. */
  const tickets = (ttlMs = 30_000) => {
    let now = 1_000;
    let issued = 0;
    const store = new ExecTickets(
      ttlMs,
      () => now,
      () => `ticket-${(issued += 1)}`,
    );
    return { store, advance: (ms: number) => (now += ms) };
  };

  it('gives back the grant it was minted for', () => {
    const { store } = tickets();
    const ticket = store.mint(grant());

    expect(store.consume(ticket)).toEqual(grant());
  });

  it('is good exactly once', () => {
    // A ticket that could be replayed would let a page that saw one open a
    // second shell after the first was closed.
    const { store } = tickets();
    const ticket = store.mint(grant());

    expect(store.consume(ticket)).toBeDefined();
    expect(store.consume(ticket)).toBeUndefined();
  });

  it('expires', () => {
    const { store, advance } = tickets(30_000);
    const ticket = store.mint(grant());

    advance(30_001);

    expect(store.consume(ticket)).toBeUndefined();
  });

  it('is still good just before it expires', () => {
    const { store, advance } = tickets(30_000);
    const ticket = store.mint(grant());

    advance(29_000);

    expect(store.consume(ticket)).toBeDefined();
  });

  it('knows nothing about a ticket it never issued', () => {
    const { store } = tickets();
    store.mint(grant());

    expect(store.consume('ticket-guessed')).toBeUndefined();
    expect(store.consume(undefined)).toBeUndefined();
    expect(store.consume('')).toBeUndefined();
  });

  it('carries which container and which Portainer the shell is for', () => {
    // The socket reads none of this from the request: the ticket is the only
    // thing that says what it may reach.
    const { store } = tickets();
    const ticket = store.mint({ instance: 'shore', execId: 'exec-9', containerId: 'abc123def456' });

    expect(store.consume(ticket)).toEqual({
      instance: 'shore',
      execId: 'exec-9',
      containerId: 'abc123def456',
    });
  });

  it('refuses to hold an unbounded number of unredeemed tickets', () => {
    const { store } = tickets();
    for (let index = 0; index < 32; index += 1) store.mint(grant(`exec-${index}`));

    expect(() => store.mint(grant('one-too-many'))).toThrow(ExecTicketError);
    expect(new ExecTicketError().status).toBe(429);
  });

  it('makes room again as tickets expire', () => {
    const { store, advance } = tickets(30_000);
    for (let index = 0; index < 32; index += 1) store.mint(grant(`exec-${index}`));

    advance(30_001);

    expect(store.outstanding).toBe(0);
    expect(() => store.mint(grant())).not.toThrow();
  });

  it('forgets everything when the plugin stops', () => {
    const { store } = tickets();
    const ticket = store.mint(grant());

    store.clear();

    expect(store.consume(ticket)).toBeUndefined();
    expect(store.outstanding).toBe(0);
  });

  it('mints something unguessable by default', () => {
    // The real generator, not the counter: this is the only thing standing
    // between a page and a shell.
    const store = new ExecTickets();
    const first = store.mint(grant());
    const second = store.mint(grant('exec-2'));

    expect(first).toHaveLength(64);
    expect(first).toMatch(/^[0-9a-f]+$/);
    expect(first).not.toBe(second);
  });
});
