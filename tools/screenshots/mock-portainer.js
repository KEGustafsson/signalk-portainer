#!/usr/bin/env node
/**
 * A pretend Portainer CE, enough of one to fill the panel for a screenshot.
 *
 * The plugin has never been pointed at a real Portainer (see the README), and
 * the screenshots in it are honest about that: they are this fixture, seen
 * through the real plugin and the real Signal K admin UI. It answers the parts
 * of the Portainer 2.x API that `src/client.ts` calls — the environment list,
 * the Docker proxy, stacks, and the exec WebSocket — with a plausible boat:
 * a Signal K server, InfluxDB, Grafana, an MQTT broker and a stopped backup job.
 *
 * Usage: node tools/screenshots/mock-portainer.js [port] [site]
 *   port  defaults to 9500
 *   site  "boat" (default) or "shore" — the second one exists so the panel's
 *         instance picker has something to pick between.
 */

const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.argv[2] ?? 9500);
const SITE = process.argv[3] ?? 'boat';
const API_KEY = 'ptr_screenshotfixture';

const now = Math.floor(Date.now() / 1000);
const days = (count) => now - count * 86400;

const BOAT_ENVIRONMENTS = [
  { Id: 1, Name: 'boat', Type: 1, Status: 1, URL: 'unix:///var/run/docker.sock' },
  { Id: 2, Name: 'shore-nas', Type: 2, Status: 1, URL: 'tcp://nas.local:9001' },
  // An edge agent that is not checking in, so the Health column has something
  // to say: edge environments report health by heartbeat rather than status.
  { Id: 3, Name: 'spare-pi', Type: 4, Heartbeat: false, EdgeCheckinInterval: 60 },
];

const BOAT_CONTAINERS = [
  {
    Id: 'c0ffee1d7a11e5b0a7c0ffee1d7a11e5b0a7c0ffee1d7a11e5b0a7c0ffee1d7a1',
    Names: ['/signalk-server'],
    Image: 'signalk/signalk-server:latest',
    Created: days(31),
    State: 'running',
    Status: 'Up 6 days (healthy)',
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' },
      { IP: '0.0.0.0', PrivatePort: 8375, PublicPort: 8375, Type: 'tcp' },
    ],
  },
  {
    Id: 'b17e5b0a7d0c4e11ab17e5b0a7d0c4e11ab17e5b0a7d0c4e11ab17e5b0a7d0c4e',
    Names: ['/influxdb'],
    Image: 'influxdb:2.7-alpine',
    Created: days(31),
    State: 'running',
    Status: 'Up 6 days (healthy)',
    Ports: [{ IP: '0.0.0.0', PrivatePort: 8086, PublicPort: 8086, Type: 'tcp' }],
  },
  {
    Id: '9a11e5d0c4b17e5b0a79a11e5d0c4b17e5b0a79a11e5d0c4b17e5b0a79a11e5d0',
    Names: ['/grafana'],
    Image: 'grafana/grafana-oss:11.3.0',
    Created: days(31),
    State: 'running',
    Status: 'Up 6 days',
    Ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3001, Type: 'tcp' }],
  },
  {
    Id: '5eab0a7d0c4e11ab17e5eab0a7d0c4e11ab17e5eab0a7d0c4e11ab17e5eab0a7d',
    Names: ['/mosquitto'],
    Image: 'eclipse-mosquitto:2.0',
    Created: days(31),
    State: 'running',
    Status: 'Up 6 days',
    Ports: [{ IP: '0.0.0.0', PrivatePort: 1883, PublicPort: 1883, Type: 'tcp' }],
  },
  {
    Id: '3ec0ffee1d7a11e5b0a73ec0ffee1d7a11e5b0a73ec0ffee1d7a11e5b0a73ec0f',
    Names: ['/nightly-backup'],
    Image: 'offen/docker-volume-backup:v2',
    Created: days(31),
    State: 'exited',
    Status: 'Exited (0) 9 hours ago',
    Ports: [],
  },
  {
    Id: '7d0c4e11ab17e5b0a7d07d0c4e11ab17e5b0a7d07d0c4e11ab17e5b0a7d07d0c4',
    Names: ['/ais-decoder'],
    Image: 'ghcr.io/boat/ais-decoder:1.4.2',
    Created: days(12),
    State: 'restarting',
    Status: 'Restarting (1) 12 seconds ago',
    Ports: [],
  },
];

const BOAT_IMAGES = [
  {
    Id: 'sha256:1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708',
    RepoTags: ['signalk/signalk-server:latest'],
    Created: days(9),
    Size: 412_233_984,
    Containers: 1,
  },
  {
    Id: 'sha256:2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80912',
    RepoTags: ['influxdb:2.7-alpine'],
    Created: days(38),
    Size: 176_492_544,
    Containers: 1,
  },
  {
    Id: 'sha256:3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b',
    RepoTags: ['grafana/grafana-oss:11.3.0'],
    Created: days(52),
    Size: 421_527_552,
    Containers: 1,
  },
  {
    Id: 'sha256:4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c',
    RepoTags: ['eclipse-mosquitto:2.0'],
    Created: days(74),
    Size: 12_582_912,
    Containers: 1,
  },
  {
    Id: 'sha256:5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
    RepoTags: ['offen/docker-volume-backup:v2'],
    Created: days(61),
    Size: 28_311_552,
    Containers: 1,
  },
  {
    Id: 'sha256:6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e',
    RepoTags: [],
    Created: days(96),
    Size: 388_071_424,
    Containers: 0,
  },
];

const BOAT_VOLUMES = [
  {
    Name: 'signalk-data',
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/signalk-data/_data',
    Scope: 'local',
  },
  {
    Name: 'influx-data',
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/influx-data/_data',
    Scope: 'local',
  },
  {
    Name: 'grafana-storage',
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/grafana-storage/_data',
    Scope: 'local',
  },
  {
    Name: 'mosquitto-config',
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/mosquitto-config/_data',
    Scope: 'local',
  },
  {
    Name: 'backup-archive',
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/backup-archive/_data',
    Scope: 'local',
  },
];

const BOAT_NETWORKS = [
  {
    Id: 'n1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809',
    Name: 'bridge',
    Driver: 'bridge',
    Scope: 'local',
    Internal: false,
  },
  {
    Id: 'n2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80912',
    Name: 'boat_default',
    Driver: 'bridge',
    Scope: 'local',
    Internal: false,
  },
  {
    Id: 'n3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b',
    Name: 'metrics',
    Driver: 'bridge',
    Scope: 'local',
    Internal: true,
  },
  {
    Id: 'n4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c',
    Name: 'host',
    Driver: 'host',
    Scope: 'local',
    Internal: false,
  },
];

const BOAT_STACKS = [
  {
    Id: 3,
    Name: 'boat-core',
    Type: 2,
    EndpointId: 1,
    EntryPoint: 'docker-compose.yml',
    Status: 1,
    CreationDate: days(31),
    UpdateDate: days(6),
    Env: [{ name: 'TZ', value: 'Europe/Helsinki' }],
    GitConfig: null,
  },
  {
    Id: 4,
    Name: 'metrics',
    Type: 2,
    EndpointId: 1,
    EntryPoint: 'docker-compose.yml',
    Status: 1,
    CreationDate: days(31),
    UpdateDate: days(12),
    Env: [],
    GitConfig: {
      URL: 'https://github.com/example/boat-stacks',
      ReferenceName: 'refs/heads/main',
      ConfigFilePath: 'metrics/docker-compose.yml',
    },
  },
  {
    Id: 5,
    Name: 'nightly-backup',
    Type: 2,
    EndpointId: 1,
    EntryPoint: 'docker-compose.yml',
    Status: 2,
    CreationDate: days(31),
    UpdateDate: days(31),
    Env: [{ name: 'BACKUP_CRON_EXPRESSION', value: '0 3 * * *' }],
    GitConfig: null,
  },
];

const BOAT_STACK_FILES = {
  3: `services:
  signalk-server:
    image: signalk/signalk-server:latest
    container_name: signalk-server
    restart: unless-stopped
    network_mode: host
    volumes:
      - signalk-data:/home/node/.signalk
    environment:
      - TZ=\${TZ}

  mosquitto:
    image: eclipse-mosquitto:2.0
    container_name: mosquitto
    restart: unless-stopped
    ports:
      - 1883:1883
    volumes:
      - mosquitto-config:/mosquitto/config

volumes:
  signalk-data:
  mosquitto-config:
`,
  4: `services:
  influxdb:
    image: influxdb:2.7-alpine
    restart: unless-stopped
    ports:
      - 8086:8086
    volumes:
      - influx-data:/var/lib/influxdb2

  grafana:
    image: grafana/grafana-oss:11.3.0
    restart: unless-stopped
    ports:
      - 3001:3000
    volumes:
      - grafana-storage:/var/lib/grafana

volumes:
  influx-data:
  grafana-storage:
`,
  5: `services:
  nightly-backup:
    image: offen/docker-volume-backup:v2
    restart: unless-stopped
    environment:
      - BACKUP_CRON_EXPRESSION=\${BACKUP_CRON_EXPRESSION}
    volumes:
      - signalk-data:/backup/signalk-data:ro
      - backup-archive:/archive

volumes:
  signalk-data:
  backup-archive:
`,
};

// ── the other site ────────────────────────────────────────────────────────
// A second Portainer, so the panel's instance picker has two entries. One
// environment, which is also why the environment picker disappears on it.

const SHORE_ENVIRONMENTS = [
  { Id: 1, Name: 'nas', Type: 1, Status: 1, URL: 'unix:///var/run/docker.sock' },
];

const SHORE_CONTAINERS = [
  {
    Id: 'a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718',
    Names: ['/portainer'],
    Image: 'portainer/portainer-ce:2.21.4',
    Created: days(180),
    State: 'running',
    Status: 'Up 22 days',
    Ports: [{ IP: '0.0.0.0', PrivatePort: 9443, PublicPort: 9443, Type: 'tcp' }],
  },
  {
    Id: 'b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1',
    Names: ['/nextcloud'],
    Image: 'nextcloud:30-apache',
    Created: days(180),
    State: 'running',
    Status: 'Up 22 days (healthy)',
    Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
  },
  {
    Id: 'c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2',
    Names: ['/chart-sync'],
    Image: 'ghcr.io/example/chart-sync:0.9.1',
    Created: days(44),
    State: 'exited',
    Status: 'Exited (0) 2 days ago',
    Ports: [],
  },
];

const SHORE_IMAGES = [
  {
    Id: 'sha256:aa1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f6071',
    RepoTags: ['portainer/portainer-ce:2.21.4'],
    Created: days(120),
    Size: 297_795_584,
    Containers: 1,
  },
  {
    Id: 'sha256:bb2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a',
    RepoTags: ['nextcloud:30-apache'],
    Created: days(51),
    Size: 1_154_482_176,
    Containers: 1,
  },
  {
    Id: 'sha256:cc3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b',
    RepoTags: ['ghcr.io/example/chart-sync:0.9.1'],
    Created: days(44),
    Size: 84_934_656,
    Containers: 1,
  },
];

const SHORE_VOLUMES = [
  {
    Name: 'portainer-data',
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/portainer-data/_data',
    Scope: 'local',
  },
  {
    Name: 'nextcloud-data',
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/nextcloud-data/_data',
    Scope: 'local',
  },
  {
    Name: 'charts',
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/charts/_data',
    Scope: 'local',
  },
];

const SHORE_NETWORKS = [
  {
    Id: 'm1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809',
    Name: 'bridge',
    Driver: 'bridge',
    Scope: 'local',
    Internal: false,
  },
  {
    Id: 'm2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80912',
    Name: 'nas_default',
    Driver: 'bridge',
    Scope: 'local',
    Internal: false,
  },
];

const SHORE_STACKS = [
  {
    Id: 1,
    Name: 'nas',
    Type: 2,
    EndpointId: 1,
    EntryPoint: 'docker-compose.yml',
    Status: 1,
    CreationDate: days(180),
    UpdateDate: days(22),
    Env: [],
    GitConfig: null,
  },
];

const SHORE_STACK_FILES = {
  1: `services:
  nextcloud:
    image: nextcloud:30-apache
    restart: unless-stopped
    ports:
      - 8080:80
    volumes:
      - nextcloud-data:/var/www/html

volumes:
  nextcloud-data:
`,
};

const SITES = {
  boat: {
    ENVIRONMENTS: BOAT_ENVIRONMENTS,
    CONTAINERS: BOAT_CONTAINERS,
    IMAGES: BOAT_IMAGES,
    VOLUMES: BOAT_VOLUMES,
    NETWORKS: BOAT_NETWORKS,
    STACKS: BOAT_STACKS,
    STACK_FILES: BOAT_STACK_FILES,
  },
  shore: {
    ENVIRONMENTS: SHORE_ENVIRONMENTS,
    CONTAINERS: SHORE_CONTAINERS,
    IMAGES: SHORE_IMAGES,
    VOLUMES: SHORE_VOLUMES,
    NETWORKS: SHORE_NETWORKS,
    STACKS: SHORE_STACKS,
    STACK_FILES: SHORE_STACK_FILES,
  },
};

const { ENVIRONMENTS, CONTAINERS, IMAGES, VOLUMES, NETWORKS, STACKS, STACK_FILES } =
  SITES[SITE] ?? SITES.boat;

const LOG_LINES = [
  ['stdout', 'signalk-server running at 0.0.0.0:3000'],
  ['stdout', 'Version: 2.16.0'],
  ['stdout', 'Loading plugin signalk-portainer'],
  ['stdout', 'signalk-portainer: boat: Portainer 2.21.4, Docker 27.3.1, environment "boat"'],
  ['stdout', 'Connected to NMEA2000 via canboat: can0'],
  ['stdout', 'Serving Signal K deltas on ws://0.0.0.0:3000/signalk/v1/stream'],
  ['stdout', 'n2k-signalk: 1284 PGNs/minute from 6 devices'],
  ['stderr', 'n2k-signalk: unknown PGN 130824, ignoring'],
  ['stdout', 'signalk-portainer: published 6 containers to system.docker.boat'],
  ['stdout', 'AIS: 14 vessels in range'],
  ['stdout', 'Anchor alarm plugin: watching, radius 45 m'],
  ['stdout', 'derived-data: computing true wind from apparent'],
  ['stdout', 'signalk-portainer: published 6 containers to system.docker.boat'],
  ['stdout', 'Delta stream: 41 subscribers'],
  ['stdout', 'influxdb writer: 2400 points in 1.2 s'],
  ['stderr', 'gpsd: fix lost, waiting for satellites'],
  ['stdout', 'gpsd: 3D fix, 9 satellites'],
  ['stdout', 'signalk-portainer: published 6 containers to system.docker.boat'],
  ['stdout', 'course-provider: no active route'],
  ['stdout', 'Autopilot: standby'],
];

/** Docker's stream multiplexing: an 8-byte header per frame, then the payload. */
function dockerFrame(stream, text) {
  const payload = Buffer.from(`${text}\n`, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(stream === 'stderr' ? 2 : 1, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * The container's log so far. Docker only prepends timestamps when asked to,
 * so the fixture only does either — the viewer's Timestamps checkbox is what
 * decides, exactly as it would against a real daemon.
 */
function containerLog(name, timestamps) {
  const stamp = (index) => new Date(Date.now() - (LOG_LINES.length - index) * 4000).toISOString();
  return Buffer.concat(
    LOG_LINES.map(([stream, text], index) => {
      const line = text.replace('signalk-server', name);
      return dockerFrame(stream, timestamps ? `${stamp(index)} ${line}` : line);
    }),
  );
}

const jsonBody = (res, body, status = 200) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const authorized = req.headers['x-api-key'] === API_KEY || req.headers.authorization;
  if (!authorized) return jsonBody(res, { message: 'Unauthorized' }, 401);

  // ── Portainer's own API ────────────────────────────────────────────────
  if (path === '/api/auth') return jsonBody(res, { jwt: 'screenshot.fixture.jwt' });
  if (path === '/api/system/status')
    return jsonBody(res, { Version: '2.21.4', InstanceID: 'screenshot-fixture' });
  if (path === '/api/endpoints') return jsonBody(res, ENVIRONMENTS);
  if (path === '/api/stacks' && req.method === 'GET') return jsonBody(res, STACKS);

  const stackFile = path.match(/^\/api\/stacks\/(\d+)\/file$/);
  if (stackFile)
    return jsonBody(res, { StackFileContent: STACK_FILES[Number(stackFile[1])] ?? '' });

  const stackId = path.match(/^\/api\/stacks\/(\d+)(\/(start|stop))?$/);
  if (stackId) {
    const stack = STACKS.find((candidate) => candidate.Id === Number(stackId[1]));
    if (!stack) return jsonBody(res, { message: 'Stack not found' }, 404);
    if (req.method === 'POST' && stackId[3]) stack.Status = stackId[3] === 'start' ? 1 : 2;
    return jsonBody(res, stack);
  }

  // ── the Docker proxy ───────────────────────────────────────────────────
  const proxy = path.match(/^\/api\/endpoints\/(\d+)\/docker(\/.*)$/);
  if (!proxy) return jsonBody(res, { message: `No route for ${path}` }, 404);
  const docker = proxy[2];

  if (docker === '/info') {
    return jsonBody(res, {
      ServerVersion: '27.3.1',
      Name: 'boat-pi',
      OperatingSystem: 'Raspberry Pi OS (bookworm)',
      Containers: CONTAINERS.length,
      ContainersRunning: CONTAINERS.filter((entry) => entry.State === 'running').length,
      ContainersStopped: CONTAINERS.filter((entry) => entry.State === 'exited').length,
      Images: IMAGES.length,
      // Not a swarm: a boat runs one Docker host, which is also what makes the
      // Services and Nodes tabs stay hidden in the screenshots.
      Swarm: { LocalNodeState: 'inactive' },
    });
  }
  if (docker.startsWith('/containers/json')) return jsonBody(res, CONTAINERS);
  if (docker.startsWith('/images/json')) return jsonBody(res, IMAGES);
  if (docker.startsWith('/volumes')) return jsonBody(res, { Volumes: VOLUMES });
  if (docker.startsWith('/networks')) return jsonBody(res, NETWORKS);
  if (docker.startsWith('/services') || docker.startsWith('/nodes')) {
    return jsonBody(res, { message: 'This node is not a swarm manager.' }, 503);
  }

  const logs = docker.match(/^\/containers\/([^/]+)\/logs/);
  if (logs) {
    const container = CONTAINERS.find((entry) => entry.Id === decodeURIComponent(logs[1]));
    const timestamps = url.searchParams.get('timestamps') === 'true';
    const body = containerLog((container?.Names[0] ?? '/container').slice(1), timestamps);
    res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' });
    if (!url.searchParams.has('follow')) return res.end(body);
    // Following: the history, then a line every couple of seconds until the
    // viewer goes away.
    res.write(body);
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      const line = `signalk-portainer: poll ${count}: 5 running, 1 stopped`;
      res.write(dockerFrame('stdout', timestamps ? `${new Date().toISOString()} ${line}` : line));
    }, 2000);
    // Bound to the response rather than the request: the response is what the
    // interval writes to, and writing to one whose client has gone is the
    // failure this is here to avoid.
    return res.on('close', () => clearInterval(timer));
  }

  const exec = docker.match(/^\/containers\/([^/]+)\/exec$/);
  if (exec && req.method === 'POST')
    return jsonBody(res, { Id: `exec-${Date.now().toString(16)}` });
  if (/^\/exec\/[^/]+\/resize/.test(docker)) return jsonBody(res, {});

  // Lifecycle: Docker answers 204, and 304 for a container already in the
  // state being asked for.
  const lifecycle = docker.match(
    /^\/containers\/([^/]+)\/(start|stop|restart|kill|pause|unpause)$/,
  );
  if (lifecycle && req.method === 'POST') {
    const container = CONTAINERS.find((entry) => entry.Id === decodeURIComponent(lifecycle[1]));
    if (!container) return jsonBody(res, { message: 'No such container' }, 404);
    const action = lifecycle[2];
    if (action === 'start') {
      if (container.State === 'running') return res.writeHead(304).end();
      container.State = 'running';
      container.Status = 'Up 1 second';
    } else if (action === 'stop' || action === 'kill') {
      container.State = 'exited';
      container.Status = `Exited (${action === 'kill' ? 137 : 0}) 1 second ago`;
    } else if (action === 'restart') {
      container.State = 'running';
      container.Status = 'Up 1 second';
    } else {
      container.State = action === 'pause' ? 'paused' : 'running';
      container.Status = action === 'pause' ? 'Up 6 days (Paused)' : 'Up 6 days';
    }
    return res.writeHead(204).end();
  }

  if (/^\/containers\/[^/]+$/.test(docker) && req.method === 'DELETE')
    return res.writeHead(204).end();

  return jsonBody(res, { message: `No route for ${docker}` }, 404);
});

// ── the exec WebSocket, playing the part of a shell ────────────────────────
const shell = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/api/websocket/exec')) return socket.destroy();
  shell.handleUpgrade(req, socket, head, (ws) => {
    let line = '';
    const prompt = () => ws.send('\r\n\u001b[1;32msignalk-server\u001b[0m:/# ');
    ws.send('\u001b[1;32msignalk-server\u001b[0m:/# ');
    ws.on('message', (data) => {
      const text = data.toString();
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          ws.send('\r\n');
          ws.send(
            `${RESPONSES[line.trim()] ?? (line.trim() ? `sh: ${line.trim()}: not found` : '')}`,
          );
          line = '';
          prompt();
        } else if (char === '\u007f') {
          if (line.length > 0) {
            line = line.slice(0, -1);
            ws.send('\b \b');
          }
        } else {
          line += char;
          ws.send(char);
        }
      }
    });
  });
});

const RESPONSES = {
  ls: 'bin   dev  home  lib  proc  run   srv  tmp  var\r\nboot  etc  init  opt  root  sbin  sys  usr',
  'ls -l /home/node/.signalk': [
    'total 28',
    'drwxr-xr-x  3 node node 4096 Aug 14 05:12 baseDeltas.json',
    'drwxr-xr-x  8 node node 4096 Aug 14 05:12 node_modules',
    '-rw-r--r--  1 node node 2118 Aug 20 19:41 plugin-config-data',
    '-rw-r--r--  1 node node  704 Aug 14 05:12 settings.json',
  ].join('\r\n'),
  'uname -a': 'Linux signalk-server 6.6.51+rpt-rpi-v8 #1 SMP PREEMPT aarch64 GNU/Linux',
  whoami: 'root',
  uptime: ' 09:41:22 up 6 days,  2:14,  0 users,  load average: 0.34, 0.41, 0.38',
  'df -h /': [
    'Filesystem      Size  Used Avail Use% Mounted on',
    'overlay          59G   14G   43G  25% /',
  ].join('\r\n'),
};

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`mock Portainer on http://127.0.0.1:${PORT} (API key ${API_KEY})\n`);
});
