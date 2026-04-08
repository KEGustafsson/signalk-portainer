# signalk-portainer

SignalK embedded webapp plugin that integrates [Portainer CE](https://www.portainer.io/) container management into the SignalK admin UI.

Portainer CE runs in its own Docker container on the same machine as SignalK. This plugin reverse-proxies Portainer into SignalK, so you can manage your Docker containers directly from the SignalK admin interface without opening a separate port or browser tab.

## Prerequisites

- [SignalK server](https://github.com/SignalK/signalk-server) (v2.x or later)
- [Docker](https://docs.docker.com/get-docker/) installed on the same host
- [Portainer CE](https://docs.portainer.io/start/install-ce) running in a Docker container
- Node.js >= 18

## Installation

### Via SignalK Appstore (recommended)

1. Open the SignalK admin UI
2. Navigate to **Appstore** > **Available**
3. Search for **Portainer CE**
4. Click **Install**
5. Restart SignalK server

### Via npm

```bash
cd ~/.signalk
npm install signalk-portainer
```

Then restart the SignalK server.

## Portainer Setup

If you don't already have Portainer CE running, start it with Docker:

```bash
docker volume create portainer_data

docker run -d \
  -p 9443:9443 \
  --name portainer \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:lts
```

Portainer CE v2.9+ defaults to **HTTPS on port 9443** with a self-signed certificate. Configure the plugin with scheme `https`, port `9443`, and enable **Allow Self-Signed Certificates**.

<details>
<summary>Legacy HTTP setup (Portainer &lt; v2.9 or manually enabled HTTP)</summary>

```bash
docker run -d \
  -p 9000:9000 \
  --name portainer \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:lts \
  --http-enabled
```

Use scheme `http` and port `9000` in the plugin configuration.

</details>

## Plugin Configuration

After installation, configure the plugin in the SignalK admin UI:

1. Navigate to **Server** > **Plugin Config**
2. Find **Portainer CE** in the plugin list
3. Enable the plugin
4. Configure the settings:

| Setting                            | Description                                          | Default     |
| ---------------------------------- | ---------------------------------------------------- | ----------- |
| **Portainer Scheme**               | Protocol to use (`http` or `https`)                  | `http`      |
| **Portainer Host**                 | Hostname or IP address where Portainer is running    | `127.0.0.1` |
| **Portainer Port**                 | Port number of the Portainer instance                | `9000`\*    |
| **Allow Self-Signed Certificates** | Accept self-signed TLS certs (only applies to HTTPS) | `false`     |

\*The plugin defaults to port 9000 for backward compatibility. Portainer CE v2.9+ defaults to HTTPS on port **9443** — set **Portainer Scheme** to `https` and **Portainer Port** to `9443` for newer installations.

5. Click **Submit** to save

### Common configurations

**Portainer on the same host (default):**

- Scheme: `http`
- Host: `127.0.0.1`
- Port: `9000`

**Portainer on a different host:**

- Host: `192.168.1.100` (the IP of the host running Portainer)
- Port: `9000`

**Portainer with HTTPS (e.g. self-signed cert):**

- Scheme: `https`
- Host: `127.0.0.1`
- Port: `9443`
- Allow Self-Signed Certificates: `true`

## Usage

Once the plugin is enabled and configured:

1. Open the SignalK admin UI
2. Navigate to **Webapps**
3. Click **Portainer CE**
4. Portainer loads embedded within the SignalK admin UI frame

The first time you access Portainer, you will need to create an admin user through the Portainer setup wizard.

### Features available through the proxy

- Full Portainer CE web interface
- Container management (start, stop, restart, remove)
- Image management
- Volume and network management
- Container console/terminal access (WebSocket-based)
- Container logs
- Docker Compose / Stacks

## Troubleshooting

### Portainer not loading (503 error)

- Ensure the Portainer container is running: `docker ps | grep portainer`
- Verify the host and port settings match your Portainer deployment
- Check that the plugin is enabled in SignalK Plugin Config

### Connection refused

- If Portainer runs in Docker, ensure the port is mapped to the host (e.g. `-p 9443:9443`)
- Check firewall rules if Portainer is on a different host
- Verify connectivity:
  - HTTP: `curl http://127.0.0.1:9000`
  - HTTPS (self-signed): `curl -k https://127.0.0.1:9443`
- Adjust host and port to match your Portainer deployment

### Container console/terminal not working

- WebSocket connections are proxied automatically
- Ensure no additional reverse proxy between the browser and SignalK is stripping WebSocket headers
- Check that the `Upgrade` and `Connection` headers are preserved

### Blank page or assets not loading

- Clear browser cache and reload
- Check the browser developer console for errors
- Ensure Portainer is fully started (it may take a few seconds after container start)

## Development

### Setup

```bash
git clone https://github.com/KEGustafsson/signalk-portainer.git
cd signalk-portainer
npm install
```

### Build

```bash
npm run build          # Build both plugin and UI
npm run build:plugin   # Build plugin only (TypeScript)
npm run build:ui       # Build UI only (webpack)
```

### Test

```bash
npm test               # Run all tests with coverage
npm run test:watch     # Run tests in watch mode
```

### Lint & Format

```bash
npm run lint           # Check for lint errors
npm run lint:fix       # Auto-fix lint errors
npm run format         # Format code with Prettier
npm run format:check   # Check formatting
```

### Link for local development

```bash
npm run build
cd ~/.signalk
npm link /path/to/signalk-portainer
```

Then restart SignalK server. Changes to the plugin source require rebuilding and restarting.

## License

[MIT](LICENSE)
