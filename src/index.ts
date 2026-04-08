import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { Socket } from 'net'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'

interface ServerAPIWithServer extends ServerAPI {
  server?: Server
}

type AppScheme = 'http' | 'https'

interface AppConfig {
  name: string
  host: string
  port: number
  scheme: AppScheme
  allowSelfSigned: boolean
}

const PLUGIN_ID = 'signalk-web-proxy'
const PLUGIN_NAME = 'Web Application Proxy'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 80
const DEFAULT_SCHEME: AppScheme = 'http'
const VALID_SCHEMES = new Set<string>(['http', 'https'])

const HOST_PATTERN = /^[a-zA-Z0-9._-]+$/
const CLOUD_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])

// RFC 7230 §3.2.6 — characters valid in a header field name (HTTP token)
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Maximum number of app slots registered with the router at startup.
// Slots beyond the configured app count return 503.
const MAX_APP_SLOTS = 16

const PROXY_SUBPATH = '/proxy'
const PLUGIN_PATH_PREFIX = `/plugins/${PLUGIN_ID}`

function stripInvalidHeaders(req: IncomingMessage): void {
  if (!req.headers) return
  for (const key of Object.keys(req.headers)) {
    if (!HTTP_TOKEN_RE.test(key)) {
      delete req.headers[key]
    }
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '')
}

function isValidHost(host: string): boolean {
  const normalized = normalizeHost(host)
  if (!HOST_PATTERN.test(normalized)) return false
  if (CLOUD_METADATA_HOSTS.has(normalized)) return false
  return true
}

function buildTarget(appConfig: AppConfig): string {
  // Validate via URL constructor, then rebuild explicitly so the port is
  // always present (url.origin strips default ports like 80 and 443).
  const url = new URL(`${appConfig.scheme}://${appConfig.host}:${String(appConfig.port)}`)
  if (url.username || url.password || url.pathname !== '/') {
    throw new Error('Invalid app host configuration')
  }
  return `${url.protocol}//${url.hostname}:${String(appConfig.port)}`
}

function parseAppConfig(raw: Record<string, unknown>, index: number): AppConfig {
  const rawHost = typeof raw['host'] === 'string' ? raw['host'] : ''
  const normalizedHost = normalizeHost(rawHost)
  const host =
    normalizedHost.length > 0 && isValidHost(rawHost) ? normalizedHost : DEFAULT_HOST
  const port =
    typeof raw['port'] === 'number' &&
    Number.isInteger(raw['port']) &&
    raw['port'] >= 1 &&
    raw['port'] <= 65535
      ? raw['port']
      : DEFAULT_PORT
  const scheme =
    typeof raw['scheme'] === 'string' && VALID_SCHEMES.has(raw['scheme'])
      ? (raw['scheme'] as AppScheme)
      : DEFAULT_SCHEME
  const allowSelfSigned =
    typeof raw['allowSelfSigned'] === 'boolean' ? raw['allowSelfSigned'] : false
  const rawName = typeof raw['name'] === 'string' ? raw['name'].trim() : ''
  const name = rawName.length > 0 ? rawName : `App ${index}`
  return { name, host, port, scheme, allowSelfSigned }
}

function parseConfig(config: object): AppConfig[] {
  const raw = config as Record<string, unknown>
  const apps = Array.isArray(raw['apps']) ? raw['apps'] : []
  return apps
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .map((a, i) => parseAppConfig(a, i))
}

module.exports = function (app: ServerAPIWithServer): Plugin {
  let proxies: RequestHandler[] = []
  let currentApps: AppConfig[] = []
  let started = false
  let upgradeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'General reverse proxy — embed any web application as a webapp in SignalK',

    start(config: object, _restart: (newConfiguration: object) => void): void {
      currentApps = parseConfig(config)
      started = true

      proxies = currentApps.map((appConfig) =>
        createProxyMiddleware({
          target: buildTarget(appConfig),
          changeOrigin: true,
          ws: false,
          secure: !(appConfig.scheme === 'https' && appConfig.allowSelfSigned),
          on: {
            proxyReq(proxyReq, req): void {
              const remoteAddress = req.socket?.remoteAddress ?? ''
              proxyReq.setHeader('X-Real-IP', remoteAddress)
              const existing = req.headers['x-forwarded-for']
              const forwarded = existing
                ? `${String(existing)}, ${remoteAddress}`
                : remoteAddress
              proxyReq.setHeader('X-Forwarded-For', forwarded)
              const incomingProto = req.headers['x-forwarded-proto']
              const rawProto =
                typeof incomingProto === 'string'
                  ? incomingProto
                  : (incomingProto?.[0] ?? '')
              const proto =
                rawProto.split(',')[0]?.trim() ||
                ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http')
              proxyReq.setHeader('X-Forwarded-Proto', proto)
            },
            error(err: Error, _req: IncomingMessage, res: ServerResponse | Socket): void {
              app.error(`Web proxy error: ${err.message}`)
              if (res instanceof Socket) {
                res.destroy()
                return
              }
              if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' })
              }
              res.end(JSON.stringify({ error: 'Application is not reachable' }))
            },
          },
        }),
      )

      if (app.server && proxies.length > 0) {
        // Forward WebSocket upgrades to the correct per-app proxy.
        // ws:false above means http-proxy-middleware does NOT auto-intercept
        // upgrades; we dispatch manually so only our plugin paths are affected.
        upgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
          const prefix = `${PLUGIN_PATH_PREFIX}${PROXY_SUBPATH}/`
          if (!req.url?.startsWith(prefix)) return
          const rest = req.url.substring(prefix.length) // e.g. "0/api/websocket/exec"
          const slash = rest.indexOf('/')
          const indexStr = slash >= 0 ? rest.substring(0, slash) : rest
          if (!/^\d+$/.test(indexStr)) return
          const index = Number(indexStr)
          if (index >= proxies.length) return
          const targetProxy = proxies[index]
          if (!targetProxy) return
          const proxyUpgrade = targetProxy.upgrade
          if (!proxyUpgrade) return
          stripInvalidHeaders(req)
          req.url = slash >= 0 ? rest.substring(slash) : '/'
          proxyUpgrade.call(targetProxy, req, socket, head)
        }
        app.server.on('upgrade', upgradeHandler)
      }
    },

    stop(): void {
      if (upgradeHandler && app.server) {
        app.server.removeListener('upgrade', upgradeHandler)
      }
      upgradeHandler = null
      proxies = []
      currentApps = []
      started = false
    },

    registerWithRouter(router: IRouter): void {
      // List configured apps — consumed by the React UI on load.
      router.get('/apps', (_req: Request, res: Response): void => {
        const list = currentApps.map((a, i) => ({ index: i, name: a.name }))
        res.json(list)
      })

      // Register a fixed set of per-app proxy slots.
      // SignalK calls registerWithRouter once at server start (before start()),
      // so we pre-register MAX_APP_SLOTS slots; slots without a running proxy
      // return 503 until start() is called with matching config.
      for (let i = 0; i < MAX_APP_SLOTS; i++) {
        const idx = i
        router.use(
          `${PROXY_SUBPATH}/${idx}`,
          (req: Request, res: Response, next: () => void): void => {
            stripInvalidHeaders(req as unknown as IncomingMessage)
            const proxy = proxies[idx]
            if (proxy) {
              ;(proxy as (req: Request, res: Response, next: () => void) => void)(req, res, next)
            } else {
              res.status(503).json({ error: 'Plugin is not started' })
            }
          },
        )
      }
    },

    schema() {
      return {
        type: 'object' as const,
        title: 'Web Application Proxy Configuration',
        description: 'Configure one or more web applications to embed in SignalK',
        properties: {
          apps: {
            type: 'array' as const,
            title: 'Web Applications',
            description: 'List of web applications to proxy',
            items: {
              type: 'object' as const,
              title: 'Application',
              properties: {
                name: {
                  type: 'string' as const,
                  title: 'Name',
                  description: 'Display name shown in the app selector',
                  default: 'My App',
                },
                scheme: {
                  type: 'string' as const,
                  title: 'Scheme',
                  description: 'Protocol to use when connecting to the application',
                  default: DEFAULT_SCHEME,
                  enum: ['http', 'https'],
                },
                host: {
                  type: 'string' as const,
                  title: 'Host',
                  description: 'Hostname or IP address of the application',
                  default: DEFAULT_HOST,
                },
                port: {
                  type: 'integer' as const,
                  title: 'Port',
                  description: 'Port number of the application',
                  default: DEFAULT_PORT,
                  minimum: 1,
                  maximum: 65535,
                },
                allowSelfSigned: {
                  type: 'boolean' as const,
                  title: 'Allow Self-Signed Certificates',
                  description: 'Accept self-signed TLS certificates (HTTPS only)',
                  default: false,
                },
              },
            },
          },
        },
      }
    },

    statusMessage(): string {
      if (!started) return 'Not started'
      if (currentApps.length === 0) return 'No apps configured'
      const targets = currentApps.map((a) => buildTarget(a)).join(', ')
      return `Proxying to: ${targets}`
    },
  }

  return plugin
}
