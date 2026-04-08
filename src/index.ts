import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { Socket } from 'net'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'

interface ServerAPIWithServer extends ServerAPI {
  server?: Server
}

type PortainerScheme = 'http' | 'https'

interface PortainerPluginConfig {
  portainerHost: string
  portainerPort: number
  portainerScheme: PortainerScheme
  allowSelfSigned: boolean
}

const PLUGIN_ID = 'signalk-portainer'
const PLUGIN_NAME = 'Portainer CE'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9000
const DEFAULT_SCHEME: PortainerScheme = 'http'
const VALID_SCHEMES = new Set<string>(['http', 'https'])

const HOST_PATTERN = /^[a-zA-Z0-9._-]+$/
const CLOUD_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '')
}

function isValidHost(host: string): boolean {
  const normalized = normalizeHost(host)
  if (!HOST_PATTERN.test(normalized)) return false
  if (CLOUD_METADATA_HOSTS.has(normalized)) return false
  return true
}

function buildTarget(config: PortainerPluginConfig): string {
  const url = new URL(
    `${config.portainerScheme}://${config.portainerHost}:${String(config.portainerPort)}`,
  )
  if (url.username || url.password || url.pathname !== '/') {
    throw new Error('Invalid Portainer host configuration')
  }
  return url.origin
}

const PROXY_SUBPATH = '/proxy'
const PLUGIN_PATH_PREFIX = `/plugins/${PLUGIN_ID}`

module.exports = function (app: ServerAPIWithServer): Plugin {
  let proxy: RequestHandler | null = null
  let currentConfig: PortainerPluginConfig | null = null
  let upgradeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null

  function parseConfig(config: object): PortainerPluginConfig {
    const raw = config as Record<string, unknown>
    const rawHost = typeof raw['portainerHost'] === 'string' ? raw['portainerHost'] : ''
    const normalized = normalizeHost(rawHost)
    const host = normalized.length > 0 && isValidHost(rawHost) ? normalized : DEFAULT_HOST
    const port =
      typeof raw['portainerPort'] === 'number' &&
      Number.isInteger(raw['portainerPort']) &&
      raw['portainerPort'] >= 1 &&
      raw['portainerPort'] <= 65535
        ? raw['portainerPort']
        : DEFAULT_PORT
    const scheme =
      typeof raw['portainerScheme'] === 'string' && VALID_SCHEMES.has(raw['portainerScheme'])
        ? (raw['portainerScheme'] as PortainerScheme)
        : DEFAULT_SCHEME
    const allowSelfSigned =
      typeof raw['allowSelfSigned'] === 'boolean' ? raw['allowSelfSigned'] : false
    return { portainerHost: host, portainerPort: port, portainerScheme: scheme, allowSelfSigned }
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'Embeds Portainer CE container management as a webapp in SignalK',

    start(config: object, _restart: (newConfiguration: object) => void): void {
      currentConfig = parseConfig(config)
      const target = buildTarget(currentConfig)

      proxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        secure: !(currentConfig.portainerScheme === 'https' && currentConfig.allowSelfSigned),
        on: {
          error(err: Error, _req: IncomingMessage, res: ServerResponse | Socket): void {
            app.error(`Portainer proxy error: ${err.message}`)
            if (res instanceof Socket) {
              res.destroy()
              return
            }
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
            }
            res.end(JSON.stringify({ error: 'Portainer is not reachable' }))
          },
        },
      })

      if (app.server && proxy.upgrade) {
        const proxyUpgrade = proxy.upgrade.bind(proxy)
        upgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
          if (req.url?.startsWith(PLUGIN_PATH_PREFIX)) {
            // Strip plugin path prefix (and optional /proxy subpath) so
            // the upstream server receives the correct resource path.
            let path = req.url.substring(PLUGIN_PATH_PREFIX.length)
            if (path.startsWith(PROXY_SUBPATH)) {
              path = path.substring(PROXY_SUBPATH.length)
            }
            req.url = path || '/'
            proxyUpgrade(req, socket, head)
          }
        }
        app.server.on('upgrade', upgradeHandler)
      }
    },

    stop(): void {
      if (upgradeHandler && app.server) {
        app.server.removeListener('upgrade', upgradeHandler)
      }
      upgradeHandler = null
      proxy = null
      currentConfig = null
    },

    registerWithRouter(router: IRouter): void {
      const handler = (req: Request, res: Response, next: () => void): void => {
        if (proxy) {
          ;(proxy as (req: Request, res: Response, next: () => void) => void)(req, res, next)
        } else {
          res.status(503).json({ error: 'Plugin is not started' })
        }
      }
      // Mount at /proxy first — the iframe loads from here to avoid
      // the reserved GET /plugins/<id> endpoint.  Express strips the
      // /proxy prefix automatically so the proxy sees the correct path.
      router.use(PROXY_SUBPATH, handler)
      // Catch-all for sub-resource requests (CSS, JS, API calls) that
      // Portainer references with paths relative to the plugin root.
      router.use('/', handler)
    },

    schema() {
      return {
        type: 'object' as const,
        title: 'Portainer CE Configuration',
        description: 'Configure the connection to your Portainer CE instance',
        properties: {
          portainerScheme: {
            type: 'string' as const,
            title: 'Portainer Scheme',
            description: 'Protocol to use when connecting to Portainer (http or https)',
            default: DEFAULT_SCHEME,
            enum: ['http', 'https'],
          },
          portainerHost: {
            type: 'string' as const,
            title: 'Portainer Host',
            description: 'Hostname or IP address of the Portainer instance',
            default: DEFAULT_HOST,
          },
          portainerPort: {
            type: 'integer' as const,
            title: 'Portainer Port',
            description: 'Port number of the Portainer instance',
            default: DEFAULT_PORT,
            minimum: 1,
            maximum: 65535,
          },
          allowSelfSigned: {
            type: 'boolean' as const,
            title: 'Allow Self-Signed Certificates',
            description:
              'Accept self-signed TLS certificates when connecting to Portainer over HTTPS',
            default: false,
          },
        },
      }
    },

    statusMessage(): string {
      if (currentConfig) {
        return `Proxying to ${buildTarget(currentConfig)}`
      }
      return 'Not started'
    },
  }

  return plugin
}
