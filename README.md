# signalk-web-proxy

SignalK embedded webapp plugin that acts as a general reverse proxy, letting you embed any web application into the SignalK admin UI.

Configure one or more applications (Portainer CE, Grafana, Node-RED, etc.). A selector UI lets you switch between them directly from the SignalK webapp panel.

## Prerequisites

- [SignalK server](https://github.com/SignalK/signalk-server) (v2.x or later)
- Node.js >= 18
- The web applications you want to embed, accessible from the SignalK host

## Installation

### Via SignalK Appstore (recommended)

1. Open the SignalK admin UI
2. Navigate to **Appstore** > **Available**
3. Search for **Web Application Proxy**
4. Click **Install**
5. Restart SignalK server

### Via npm

```bash
cd ~/.signalk
npm install signalk-web-proxy
```

Then restart the SignalK server.

## Plugin Configuration

After installation, configure the plugin in the SignalK admin UI:

1. Navigate to **Server** > **Plugin Config**
2. Find **Web Application Proxy** in the plugin list
3. Enable the plugin
4. Add one or more applications under **Web Applications**:

| Field                              | Description                                          | Default     |
| ---------------------------------- | ---------------------------------------------------- | ----------- |
| **Name**                           | Display name shown in the app selector               | `My App`    |
| **Scheme**                         | Protocol (`http` or `https`)                         | `http`      |
| **Host**                           | Hostname or IP address of the application            | `127.0.0.1` |
| **Port**                           | Port number of the application                       | `80`        |
| **Allow Self-Signed Certificates** | Accept self-signed TLS certs (HTTPS only)            | `false`     |

5. Click **Submit** to save

### Example: Portainer CE + Grafana

```json
{
  "apps": [
    {
      "name": "Portainer CE",
      "scheme": "https",
      "host": "127.0.0.1",
      "port": 9443,
      "allowSelfSigned": true
    },
    {
      "name": "Grafana",
      "scheme": "http",
      "host": "127.0.0.1",
      "port": 3000
    }
  ]
}
```

## Usage

Once the plugin is enabled and configured:

1. Open the SignalK admin UI
2. Navigate to **Webapps**
3. Click **Web Application Proxy**
4. If multiple apps are configured, select one from the dropdown
5. The selected application loads embedded in the SignalK admin UI

If only one application is configured, it loads automatically without requiring a selection.

## Proxy URL structure

Each application is accessible at:

```
/plugins/signalk-web-proxy/proxy/{index}/
```

Where `{index}` is the zero-based position of the app in the `apps` array.

| App | Proxy URL |
|-----|-----------|
| First app (index 0)  | `/plugins/signalk-web-proxy/proxy/0/` |
| Second app (index 1) | `/plugins/signalk-web-proxy/proxy/1/` |

The list of configured apps (name + index) is also available as JSON:

```
GET /plugins/signalk-web-proxy/apps
```

## Application-specific setup notes

### Portainer CE

Portainer's frontend makes API calls using absolute paths (e.g. `POST /api/auth`). Without a base URL configured these bypass the proxy and fail. Start Portainer with the `--base-url` flag:

```bash
# HTTPS (default for Portainer CE v2.9+)
docker run -d \
  -p 9443:9443 \
  --name portainer \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:lts \
  --base-url /plugins/signalk-web-proxy/proxy/0

# HTTP (legacy / manually enabled)
docker run -d \
  -p 9000:9000 \
  --name portainer \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:lts \
  --http-enabled \
  --base-url /plugins/signalk-web-proxy/proxy/0
```

> Adjust `/proxy/0` to match the index of Portainer in your `apps` array.

## Troubleshooting

### Application not loading (503 error)

- Ensure the target application is running and reachable from the SignalK host
- Verify the host, port, and scheme settings
- Check that the plugin is enabled in SignalK Plugin Config

### Connection refused

- Confirm the application port is bound on the host (e.g. `-p 9443:9443` for Docker)
- Check firewall rules if the application runs on a different host
- Test connectivity directly: `curl http://127.0.0.1:<port>`

### Login or POST requests hang

The application's frontend is making API calls with absolute paths that bypass the proxy. Configure the application to use the proxy subpath as a base URL (see **Portainer CE** section above).

### Container console/terminal not working (WebSocket)

- WebSocket upgrade connections are proxied automatically per app
- Ensure no upstream reverse proxy is stripping `Upgrade` / `Connection` headers

### Blank page or assets not loading

- Clear browser cache and reload
- Check the browser developer console for errors
- Ensure the application is fully started before accessing it

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
