import { detectSelfContainer, isSelfContainer, type SelfContainer } from '../src/self';

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const SHORT = ID.slice(0, 12);

/** Real-world /proc contents, since the formats vary by driver and cgroup version. */
const fixtures = {
  cgroupV1Cgroupfs: `12:pids:/docker/${ID}\n11:memory:/docker/${ID}\n`,
  cgroupV1Systemd: `1:name=systemd:/system.slice/docker-${ID}.scope\n`,
  cgroupV2Bare: '0::/\n',
  cgroupV2InDocker: '0::/docker\n',
  kubepods: `11:memory:/kubepods/besteffort/pod8f3a/${ID}\n`,
  criContainerd: `0::/system.slice/cri-containerd-${ID}.scope\n`,
  hostNoContainer: '12:pids:/\n11:memory:/user.slice/user-1000.slice\n',
  mountinfoDocker: `1234 1200 0:59 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw,relatime\n`,
  mountinfoHost: '25 30 0:22 / /proc rw,nosuid,nodev,noexec\n',
  /**
   * What a Docker *host* has in its own mount table: an shm and an overlay
   * mount for every container it is running. The ids in them are other
   * containers', and reading one as our own is how a Signal K installed on
   * the host decided it was Portainer and refused to stop it.
   */
  mountinfoDockerHost:
    `1039 28 0:52 / /var/lib/docker/containers/${ID}/mounts/shm rw,nosuid,nodev,noexec shared:512 - tmpfs shm rw,size=65536k\n` +
    `1104 28 0:56 / /var/lib/docker/overlay2/2b9c/merged rw,relatime shared:520 - overlay overlay rw\n`,
  /** podman's equivalent of the bind mount Docker uses. */
  mountinfoPodman: `1234 1200 0:59 /var/lib/containers/storage/overlay-containers/${ID}/userdata/hostname /etc/hostname rw,relatime\n`,
  cgroupPodman: `0::/machine.slice/libpod-${ID}.scope\n`,
};

const sources = (over: {
  cgroup?: string;
  mountinfo?: string;
  dockerenv?: boolean;
  hostname?: string;
}) => ({
  readFile: (path: string) =>
    path === '/proc/self/cgroup'
      ? over.cgroup
      : path === '/proc/self/mountinfo'
        ? over.mountinfo
        : undefined,
  fileExists: () => over.dockerenv ?? false,
  hostname: () => over.hostname ?? 'boatpi',
});

describe('detectSelfContainer', () => {
  it('reads the id from cgroup v1 with the cgroupfs driver', () => {
    const self = detectSelfContainer(sources({ cgroup: fixtures.cgroupV1Cgroupfs }));
    expect(self).toMatchObject({ inContainer: true, id: ID, shortId: SHORT, source: 'cgroup' });
    expect(self.identified).toBe(true);
  });

  it('reads the id from cgroup v1 with the systemd driver', () => {
    expect(detectSelfContainer(sources({ cgroup: fixtures.cgroupV1Systemd })).id).toBe(ID);
  });

  it('reads the id from a kubepods path', () => {
    expect(detectSelfContainer(sources({ cgroup: fixtures.kubepods })).id).toBe(ID);
  });

  it('reads the id from a cri-containerd scope', () => {
    expect(detectSelfContainer(sources({ cgroup: fixtures.criContainerd })).id).toBe(ID);
  });

  it('falls back to mountinfo when cgroup v2 hides the id', () => {
    // cgroup v2 commonly reports just "0::/" with no container id at all.
    const self = detectSelfContainer(
      sources({ cgroup: fixtures.cgroupV2Bare, mountinfo: fixtures.mountinfoDocker }),
    );
    expect(self).toMatchObject({ id: ID, source: 'mountinfo', identified: true });
  });

  it('falls back to the hostname when it looks like a short container id', () => {
    const self = detectSelfContainer(
      sources({ cgroup: fixtures.cgroupV2InDocker, hostname: SHORT }),
    );
    expect(self).toMatchObject({ inContainer: true, shortId: SHORT, source: 'hostname' });
    expect(self.id).toBeUndefined();
  });

  it('reports being in a container but unidentified when the hostname was overridden', () => {
    const self = detectSelfContainer(
      sources({ cgroup: fixtures.cgroupV2Bare, dockerenv: true, hostname: 'signalk-server' }),
    );
    // The dangerous case: containerised, but self-protection cannot work.
    expect(self).toMatchObject({ inContainer: true, identified: false, source: 'none' });
    expect(self.id).toBeUndefined();
  });

  it('reads the id from a podman scope', () => {
    expect(detectSelfContainer(sources({ cgroup: fixtures.cgroupPodman })).id).toBe(ID);
  });

  it('reads the id from podman’s own bind mount', () => {
    const self = detectSelfContainer(
      sources({ cgroup: fixtures.cgroupV2Bare, mountinfo: fixtures.mountinfoPodman }),
    );
    expect(self).toMatchObject({ id: ID, source: 'mountinfo', identified: true });
  });

  it('does not mistake another container’s mounts for its own', () => {
    // Signal K installed on the host, Docker beside it: the host's mount
    // table lists every running container's shm and overlay mounts. Matching
    // an id anywhere in that file made the plugin believe it was one of
    // those containers, and self-protection then refused to stop it — for
    // Portainer itself, as often as not.
    const self = detectSelfContainer(
      sources({ cgroup: fixtures.hostNoContainer, mountinfo: fixtures.mountinfoDockerHost }),
    );

    expect(self).toMatchObject({ inContainer: false, identified: false });
    expect(self.id).toBeUndefined();
  });

  it('reports not containerised on a bare-metal host', () => {
    const self = detectSelfContainer(
      sources({ cgroup: fixtures.hostNoContainer, mountinfo: fixtures.mountinfoHost }),
    );
    expect(self).toEqual({ inContainer: false, source: 'none', identified: false });
  });

  it('survives /proc being unreadable', () => {
    const self = detectSelfContainer({
      readFile: () => undefined,
      fileExists: () => false,
      hostname: () => '',
    });
    expect(self.inContainer).toBe(false);
  });
});

describe('isSelfContainer', () => {
  const identified: SelfContainer = {
    inContainer: true,
    id: ID,
    shortId: SHORT,
    source: 'cgroup',
    identified: true,
  };

  it('matches the full id and the short id Docker displays', () => {
    expect(isSelfContainer(identified, ID)).toBe(true);
    expect(isSelfContainer(identified, SHORT)).toBe(true);
    expect(isSelfContainer(identified, SHORT.toUpperCase())).toBe(true);
  });

  it('matches when only a short id is known and a full id is supplied', () => {
    const shortOnly: SelfContainer = {
      inContainer: true,
      shortId: SHORT,
      source: 'hostname',
      identified: true,
    };
    expect(isSelfContainer(shortOnly, ID)).toBe(true);
  });

  it('does not match a different container', () => {
    expect(isSelfContainer(identified, 'f'.repeat(64))).toBe(false);
    expect(isSelfContainer(identified, 'ffffffffffff')).toBe(false);
  });

  it('refuses to match on a prefix too short to be unambiguous', () => {
    // Without a floor, "a1" would match our id and block unrelated containers.
    expect(isSelfContainer(identified, SHORT.slice(0, 4))).toBe(false);
  });

  it('never matches when we could not identify ourselves', () => {
    const unknown: SelfContainer = { inContainer: true, source: 'none', identified: false };
    expect(isSelfContainer(unknown, ID)).toBe(false);
  });
});
