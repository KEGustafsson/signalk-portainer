import { ConsoleSessions } from '../src/consolesessions';

describe('ConsoleSessions', () => {
  const session = { instance: 'boat', execId: 'exec-1', containerId: 'c1f0e2a3b4c5' };

  it('gives back what was recorded under an id', () => {
    const sessions = new ConsoleSessions();
    sessions.add('session-1', session);

    expect(sessions.get('session-1')).toEqual(session);
  });

  it('knows nothing about an id it never recorded', () => {
    const sessions = new ConsoleSessions();
    sessions.add('session-1', session);

    expect(sessions.get('session-guessed')).toBeUndefined();
    expect(sessions.get(undefined)).toBeUndefined();
    expect(sessions.get('')).toBeUndefined();
  });

  it('forgets a console that has ended', () => {
    const sessions = new ConsoleSessions();
    sessions.add('session-1', session);

    sessions.remove('session-1');

    expect(sessions.get('session-1')).toBeUndefined();
    expect(sessions.size).toBe(0);
  });

  it('takes a removal of something that was never there', () => {
    // The relay's onEnd runs however the shell ended, including paths where
    // nothing was ever recorded.
    const sessions = new ConsoleSessions();

    expect(() => sessions.remove('session-1')).not.toThrow();
  });

  it('holds several consoles apart', () => {
    // Two shells on the same container are allowed, and a resize must reach
    // the one it names rather than either of them.
    const sessions = new ConsoleSessions();
    sessions.add('session-1', session);
    sessions.add('session-2', { ...session, execId: 'exec-2' });

    expect(sessions.get('session-2')?.execId).toBe('exec-2');
    expect(sessions.get('session-1')?.execId).toBe('exec-1');
  });

  it('forgets everything when the plugin stops', () => {
    const sessions = new ConsoleSessions();
    sessions.add('session-1', session);

    sessions.clear();

    expect(sessions.size).toBe(0);
  });
});
