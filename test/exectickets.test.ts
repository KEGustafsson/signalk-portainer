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

  describe('reserving before there is a shell', () => {
    it('holds a place that is not yet redeemable', () => {
      // The exec instance does not exist yet; a ticket for it would be a
      // ticket to nothing.
      const { store } = tickets();
      const reservation = store.reserve();

      expect(store.outstanding).toBe(1);
      expect(store.consume('ticket-1')).toBeUndefined();

      const ticket = reservation.commit(grant());
      expect(store.consume(ticket)).toEqual(grant());
    });

    it('gives the place back when the shell never came to exist', () => {
      const { store } = tickets();
      const reservation = store.reserve();

      reservation.release();

      expect(store.outstanding).toBe(0);
    });

    it('refuses a reservation when the store is full, before anything is created', () => {
      // This is the point of reserving first: the refusal happens before the
      // exec instance is made, so none is orphaned.
      const { store } = tickets();
      for (let index = 0; index < 32; index += 1) store.mint(grant(`exec-${index}`));

      expect(() => store.reserve()).toThrow(ExecTicketError);
    });

    it('ignores a release after the reservation was committed', () => {
      const { store } = tickets();
      const reservation = store.reserve();
      const ticket = reservation.commit(grant());

      reservation.release();

      expect(store.consume(ticket)).toEqual(grant());
    });

    it('refuses to be committed twice', () => {
      const { store } = tickets();
      const reservation = store.reserve();
      reservation.commit(grant());

      expect(() => reservation.commit(grant('exec-2'))).toThrow(/already been settled/);
    });

    it('expires like any other held place', () => {
      const { store, advance } = tickets(30_000);
      store.reserve();

      advance(30_001);

      expect(store.outstanding).toBe(0);
    });
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
