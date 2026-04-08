import type { Plugin } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { IncomingMessage, ServerResponse } from 'http'
import type { Socket } from 'net'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'

interface PortainerPluginConfig {
  portainerHost: string
  portainerPort: number
}

const PLUGIN_ID = 'signalk-portainer'
const PLUGIN_NAME = 'Portainer CE'

const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = 9000

module.exports = function (): Plugin {
  let proxy: RequestHandler | null = null
  let currentConfig: PortainerPluginConfig | null = null

  function getTarget(config: PortainerPluginConfig): string {
    return `http://${config.portainerHost}:${String(config.portainerPort)}`
  }

  function parseConfig(config: object): PortainerPluginConfig {
    const raw = config as Record<string, unknown>
    return {
      portainerHost:
        typeof raw['portainerHost'] === 'string' && raw['portainerHost'].length > 0
          ? raw['portainerHost']
          : DEFAULT_HOST,
      portainerPort:
        typeof raw['portainerPort'] === 'number' &&
        raw['portainerPort'] >= 1 &&
        raw['portainerPort'] <= 65535
          ? raw['portainerPort']
          : DEFAULT_PORT,
    }
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'Embeds Portainer CE container management as a webapp in SignalK',

    start(config: object): void {
      currentConfig = parseConfig(config)
      const target = getTarget(currentConfig)

      proxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        on: {
          error(err: Error, _req: IncomingMessage, res: ServerResponse | Socket): void {
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
            }
            res.end(JSON.stringify({ error: 'Portainer is not reachable', detail: err.message }))
          },
        },
      })
    },

    stop(): void {
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
        return `Proxying to ${getTarget(currentConfig)}`
      }
      return 'Not started'
    },
  }

  return plugin
}
