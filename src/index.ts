import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { Socket } from 'net'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'

interface ServerAPIWithServer extends ServerAPI {
  server?: Server
}

interface PortainerPluginConfig {
  portainerHost: string
  portainerPort: number
}

const PLUGIN_ID = 'signalk-portainer'
const PLUGIN_NAME = 'Portainer CE'

const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = 9000

const HOST_PATTERN = /^[a-zA-Z0-9._-]+$/
const CLOUD_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])

function isValidHost(host: string): boolean {
  if (!HOST_PATTERN.test(host)) return false
  if (CLOUD_METADATA_HOSTS.has(host)) return false
  return true
}

function buildTarget(config: PortainerPluginConfig): string {
  const url = new URL(`http://${config.portainerHost}:${String(config.portainerPort)}`)
  if (url.username || url.password || url.pathname !== '/') {
    throw new Error('Invalid Portainer host configuration')
  }
  return url.origin
}

const PLUGIN_PATH_PREFIX = `/plugins/${PLUGIN_ID}/`

module.exports = function (app: ServerAPIWithServer): Plugin {
  let proxy: RequestHandler | null = null
  let currentConfig: PortainerPluginConfig | null = null
  let upgradeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null

  function parseConfig(config: object): PortainerPluginConfig {
    const raw = config as Record<string, unknown>
    const host =
      typeof raw['portainerHost'] === 'string' &&
      raw['portainerHost'].length > 0 &&
      isValidHost(raw['portainerHost'])
        ? raw['portainerHost']
        : DEFAULT_HOST
    const port =
      typeof raw['portainerPort'] === 'number' &&
      Number.isInteger(raw['portainerPort']) &&
      raw['portainerPort'] >= 1 &&
      raw['portainerPort'] <= 65535
        ? raw['portainerPort']
        : DEFAULT_PORT
    return { portainerHost: host, portainerPort: port }
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
        on: {
          error(_err: Error, _req: IncomingMessage, res: ServerResponse | Socket): void {
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
      router.use('/', (req: Request, res: Response, next: () => void) => {
        if (proxy) {
          ;(proxy as (req: Request, res: Response, next: () => void) => void)(req, res, next)
        } else {
          res.status(503).json({ error: 'Plugin is not started' })
        }
      })
    },

    schema() {
      return {
        type: 'object' as const,
        title: 'Portainer CE Configuration',
        description: 'Configure the connection to your Portainer CE instance',
        properties: {
          portainerHost: {
            type: 'string' as const,
            title: 'Portainer Host',
            description: 'Hostname or IP address of the Portainer instance',
            default: DEFAULT_HOST,
          },
          portainerPort: {
            type: 'number' as const,
            title: 'Portainer Port',
            description: 'Port number of the Portainer instance',
            default: DEFAULT_PORT,
            minimum: 1,
            maximum: 65535,
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
