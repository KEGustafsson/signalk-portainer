import { stackHoldsSelf, stackOfContainer } from '../src/stackguard';
import type { DockerContainer } from '../src/types';

const SELF = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

const container = (id: string, labels?: Record<string, string>): DockerContainer => ({
  Id: id,
  Names: ['/whatever'],
  Image: 'x:1',
  Created: 0,
  State: 'running',
  Status: 'Up',
  ...(labels ? { Labels: labels } : {}),
});

describe('stackOfContainer', () => {
  it('reads the compose project a container belongs to', () => {
    expect(stackOfContainer(container(SELF, { 'com.docker.compose.project': 'signalk' }))).toBe(
      'signalk',
    );
  });

  it('reads the swarm namespace, which is where a swarm stack records it', () => {
    expect(stackOfContainer(container(SELF, { 'com.docker.stack.namespace': 'fleet' }))).toBe(
      'fleet',
    );
  });

  it('says nothing for a container started by hand', () => {
    expect(stackOfContainer(container(SELF))).toBeUndefined();
    expect(stackOfContainer(container(SELF, { 'com.docker.compose.project': '' }))).toBeUndefined();
  });
});

describe('stackHoldsSelf', () => {
  const signalk = container(SELF, { 'com.docker.compose.project': 'signalk' });
  const other = container('ffffffffffff1111', { 'com.docker.compose.project': 'signalk' });

  it('finds the Signal K container inside its stack', () => {
    expect(stackHoldsSelf('signalk', SELF, [other, signalk])).toBe(true);
  });

  it('matches the short id the plugin usually knows itself by', () => {
    // The hostname fallback yields 12 characters, not 64.
    expect(stackHoldsSelf('signalk', SELF.slice(0, 12), [signalk])).toBe(true);
  });

  it('ignores case, since compose lowercases a project it derives from a directory', () => {
    expect(stackHoldsSelf('SignalK', SELF, [signalk])).toBe(true);
  });

  it('says no for a stack Signal K is not in', () => {
    expect(stackHoldsSelf('influxdb', SELF, [signalk, other])).toBe(false);
  });

  it('says no when another container is in the stack but Signal K is not', () => {
    // The dangerous mistake is the opposite one, but a guard that fires on
    // every stack would make the plugin useless.
    expect(stackHoldsSelf('signalk', SELF, [other])).toBe(false);
  });

  it('protects a Signal K that is currently stopped', () => {
    // Down is not gone: the stack write would bring it back down again.
    const stopped: DockerContainer = { ...signalk, State: 'exited', Status: 'Exited (0)' };
    expect(stackHoldsSelf('signalk', SELF, [stopped])).toBe(true);
  });

  it('says no when the plugin does not know which container it is', () => {
    expect(stackHoldsSelf('signalk', undefined, [signalk])).toBe(false);
  });

  it('refuses to match on a reference too short to mean anything', () => {
    // A three-character id would prefix-match half the containers on the host.
    expect(stackHoldsSelf('signalk', 'a1b', [signalk])).toBe(false);
  });

  it('says no for a stack with no name', () => {
    expect(stackHoldsSelf('   ', SELF, [signalk])).toBe(false);
  });
});
