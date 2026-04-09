import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { IncomingMessage, Server } from 'http'
import type { Socket } from 'net'
import { EventEmitter } from 'events'

type MiddlewareFn = (req: Request, res: Response, next: () => void) => void

interface MockProxyMiddleware {
  (...args: Parameters<MiddlewareFn>): void
  upgrade?: jest.Mock
}

const mockCreateProxyMiddleware = jest.fn<MockProxyMiddleware, [options: Record<string, unknown>]>()

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: (options: Record<string, unknown>) => mockCreateProxyMiddleware(options),
}))

interface ServerAPIWithServer extends ServerAPI {
  server?: Server
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pluginFactory = require('../src/index') as (app: ServerAPIWithServer) => Plugin

const mockError = jest.fn()
const mockApp = { error: mockError } as unknown as ServerAPIWithServer

/** Minimal valid config with one app entry */
function oneApp(overrides: Record<string, unknown> = {}): object {
  return { apps: [{ name: 'Test App', url: 'http://localhost:9000', ...overrides }] }
}

type ProxyReqFn = (proxyReq: { setHeader: jest.Mock }, req: unknown) => void

/** Extracts the proxyReq handler from the most recent createProxyMiddleware call. */
function extractProxyReqHandler(): ProxyReqFn {
  const options = (mockCreateProxyMiddleware.mock.calls[0] as [Record<string, unknown>])[0]
  return ((options['on'] as Record<string, unknown>)['proxyReq']) as ProxyReqFn
}

describe('signalk-web-proxy plugin', () => {
  let plugin: Plugin

  beforeEach(() => {
    jest.clearAllMocks()
    plugin = pluginFactory(mockApp)
  })

  describe('metadata', () => {
    it('has the correct plugin id', () => {
      expect(plugin.id).toBe('signalk-web-proxy')
    })

    it('has the correct plugin name', () => {
      expect(plugin.name).toBe('Web Application Proxy')
    })

    it('has a description', () => {
      expect(plugin.description).toBeDefined()
      expect(typeof plugin.description).toBe('string')
      expect(plugin.description!.length).toBeGreaterThan(0)
    })
  })

  describe('schema', () => {
    it('returns a valid JSON Schema object', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      expect(schema).toHaveProperty('type', 'object')
      expect(schema).toHaveProperty('properties')
    })

    it('defines an apps array property', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      expect(properties['apps']).toBeDefined()
      expect(properties['apps']!['type']).toBe('array')
    })

    it('apps items define name, url, allowSelfSigned, and timeout', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      const items = properties['apps']!['items'] as Record<string, unknown>
      const itemProps = items['properties'] as Record<string, Record<string, unknown>>
      expect(itemProps['name']!['type']).toBe('string')
      expect(itemProps['url']!['type']).toBe('string')
      expect(itemProps['allowSelfSigned']!['type']).toBe('boolean')
      expect(itemProps['allowSelfSigned']!['default']).toBe(false)
      expect(itemProps['timeout']!['type']).toBe('number')
      expect(itemProps['timeout']!['default']).toBe(0)
    })
  })

  describe('start/stop lifecycle', () => {
    const dummyProxy: MockProxyMiddleware = jest.fn()

    beforeEach(() => {
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)
    })

    it('creates proxy middleware with correct target on start', () => {
      plugin.start(oneApp(), jest.fn())

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(1)
      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000')
      expect(options['changeOrigin']).toBe(true)
      expect(options['ws']).toBe(false)
    })

    it('creates one proxy per configured app', () => {
      plugin.start(
        {
          apps: [
            { name: 'App A', url: 'http://localhost:9000' },
            { name: 'App B', url: 'http://192.168.1.1:3000' },
          ],
        },
        jest.fn(),
      )

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(2)
      const targets = (mockCreateProxyMiddleware.mock.calls as unknown[][]).map(
        (c) => (c[0] as Record<string, unknown>)['target'],
      )
      expect(targets).toContain('http://localhost:9000')
      expect(targets).toContain('http://192.168.1.1:3000')
    })

    it('uses custom host and port from URL', () => {
      plugin.start(oneApp({ url: 'http://192.168.1.100:9443' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://192.168.1.100:9443')
    })

    it('includes base path from URL in target', () => {
      plugin.start(oneApp({ url: 'http://localhost:9000/admin' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000/admin')
    })

    it('creates no proxies when apps array is empty', () => {
      plugin.start({ apps: [] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('reports no apps configured when started with empty apps', () => {
      plugin.start({ apps: [] }, jest.fn())

      expect(plugin.statusMessage?.()).toBe('No apps configured')
    })

    it('skips app when url field is absent', () => {
      plugin.start({ apps: [{ name: 'X' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('index 0'))
    })

    it('skips app when url is an empty string', () => {
      plugin.start({ apps: [{ name: 'X', url: '' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when url is not parseable', () => {
      plugin.start({ apps: [{ name: 'X', url: 'not a url' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('infers port 80 when http URL omits the port', () => {
      plugin.start({ apps: [{ name: 'X', url: 'http://localhost' }] }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:80')
    })

    it('infers port 443 when https URL omits the port', () => {
      plugin.start({ apps: [{ name: 'X', url: 'https://myapp.local' }] }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('https://myapp.local:443')
    })

    it('creates no proxies when apps key is missing', () => {
      plugin.start({}, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when URL scheme is not http or https', () => {
      plugin.start({ apps: [{ name: 'X', url: 'ftp://localhost:9000' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when URL contains embedded credentials', () => {
      plugin.start({ apps: [{ name: 'X', url: 'http://user:pass@evil.com:9000' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when host is an IPv6 address and reports a clear error', () => {
      plugin.start(oneApp({ url: 'http://[::1]:9000' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('IPv6'))
    })

    it('skips app when host is a cloud metadata IP', () => {
      plugin.start(oneApp({ url: 'http://169.254.169.254:9000' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when host is cloud metadata with trailing dot', () => {
      plugin.start(oneApp({ url: 'http://169.254.169.254.:9000' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when host is cloud metadata with mixed case', () => {
      plugin.start(oneApp({ url: 'http://Metadata.Google.Internal:9000' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('normalizes host to lowercase', () => {
      plugin.start(oneApp({ url: 'http://MyHost.Local:9000' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://myhost.local:9000')
    })

    it('strips trailing dot from host', () => {
      plugin.start(oneApp({ url: 'http://myhost.local.:9000' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://myhost.local:9000')
    })

    it('caps apps at MAX_APP_SLOTS and ignores entries beyond the limit', () => {
      const manyApps = Array.from({ length: 20 }, (_, i) => ({
        name: `App ${i}`,
        url: `http://localhost:${9000 + i}`,
      }))
      plugin.start({ apps: manyApps }, jest.fn())

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(16)
    })

    it('uses https scheme when URL uses https', () => {
      plugin.start(oneApp({ url: 'https://localhost:9443' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('https://localhost:9443')
      expect(options['secure']).toBe(true)
    })

    it('sets secure to false when allowSelfSigned is true with https', () => {
      plugin.start(oneApp({ url: 'https://localhost:9443', allowSelfSigned: true }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('https://localhost:9443')
      expect(options['secure']).toBe(false)
    })

    it('configures a proxyReq handler that sets forwarding headers', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()
      expect(proxyReqHandler).toBeDefined()
      expect(typeof proxyReqHandler).toBe('function')

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.1', encrypted: false },
        headers: {},
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Real-IP']).toBe('10.0.0.1')
      expect(headerMap['X-Forwarded-For']).toBe('10.0.0.1')
      expect(headerMap['X-Forwarded-Proto']).toBe('http')
    })

    it('appends to existing X-Forwarded-For header', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.2', encrypted: true },
        headers: { 'x-forwarded-for': '192.168.1.1' },
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-For']).toBe('192.168.1.1, 10.0.0.2')
      expect(headerMap['X-Forwarded-Proto']).toBe('https')
    })

    it('passes through upstream x-forwarded-proto when present', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.3', encrypted: false },
        headers: { 'x-forwarded-proto': 'https' },
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-Proto']).toBe('https')
    })

    it('takes the first value when x-forwarded-proto is comma-separated', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.4', encrypted: false },
        headers: { 'x-forwarded-proto': 'https, http' },
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-Proto']).toBe('https')
    })

    it('ignores allowSelfSigned when scheme is http', () => {
      plugin.start(oneApp({ allowSelfSigned: true }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000')
      expect(options['secure']).toBe(true)
    })

    it('cleans up on stop', () => {
      plugin.start(oneApp(), jest.fn())
      void plugin.stop()

      expect(plugin.statusMessage?.()).toBe('Not started')
    })

    it('passes proxyTimeout to middleware when timeout is configured', () => {
      plugin.start(oneApp({ timeout: 30000 }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['proxyTimeout']).toBe(30000)
    })

    it('does not set proxyTimeout when timeout is 0', () => {
      plugin.start(oneApp(), jest.fn()) // oneApp has no timeout field → defaults to 0

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['proxyTimeout']).toBeUndefined()
    })

    it('floors fractional timeout values', () => {
      plugin.start(oneApp({ timeout: 5500.9 }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['proxyTimeout']).toBe(5500)
    })
  })

  describe('statusMessage', () => {
    beforeEach(() => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
    })

    it('returns not started before start is called', () => {
      expect(plugin.statusMessage?.()).toBe('Not started')
    })

    it('returns target info after start with one app', () => {
      plugin.start(oneApp({ url: 'http://myhost:8080' }), jest.fn())
      expect(plugin.statusMessage?.()).toBe('Proxying to: http://myhost:8080')
    })

    it('returns target info including base path when url has a path', () => {
      plugin.start(oneApp({ url: 'http://myhost:8080/admin' }), jest.fn())
      expect(plugin.statusMessage?.()).toBe('Proxying to: http://myhost:8080/admin')
    })

    it('returns all targets after start with multiple apps', () => {
      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://host-a:8080' },
            { name: 'B', url: 'http://host-b:3000' },
          ],
        },
        jest.fn(),
      )
      expect(plugin.statusMessage?.()).toBe('Proxying to: http://host-a:8080, http://host-b:3000')
    })

    it('returns not started after stop', () => {
      plugin.start(oneApp(), jest.fn())
      void plugin.stop()
      expect(plugin.statusMessage?.()).toBe('Not started')
    })
  })

  describe('registerWithRouter', () => {
    let mockRouter: IRouter
    let registeredHandlers: Map<string, MiddlewareFn>
    let registeredGetHandlers: Map<string, (req: Request, res: Response) => void>

    beforeEach(() => {
      registeredHandlers = new Map()
      registeredGetHandlers = new Map()
      mockRouter = {
        use: jest.fn((path: string, handler: MiddlewareFn) => {
          registeredHandlers.set(path, handler)
          return mockRouter
        }),
        get: jest.fn(
          (path: string, handler: (req: Request, res: Response) => void) => {
            registeredGetHandlers.set(path, handler)
            return mockRouter
          },
        ),
      } as unknown as IRouter
    })

    it('registers /apps GET route', () => {
      plugin.registerWithRouter!(mockRouter)
      expect(mockRouter.get).toHaveBeenCalledWith('/apps', expect.any(Function))
    })

    it('/apps returns empty list when plugin not started', () => {
      plugin.registerWithRouter!(mockRouter)
      const handler = registeredGetHandlers.get('/apps')!
      const mockRes = { json: jest.fn() } as unknown as Response
      handler({} as Request, mockRes)
      expect(mockRes.json).toHaveBeenCalledWith([])
    })

    it('/apps returns configured app list after start', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
      plugin.start(
        {
          apps: [
            { name: 'Portainer', url: 'http://localhost:9000' },
            { name: 'Grafana', url: 'http://localhost:3000' },
          ],
        },
        jest.fn(),
      )
      plugin.registerWithRouter!(mockRouter)
      const handler = registeredGetHandlers.get('/apps')!
      const mockRes = { json: jest.fn() } as unknown as Response
      handler({} as Request, mockRes)
      expect(mockRes.json).toHaveBeenCalledWith([
        { index: 0, name: 'Portainer' },
        { index: 1, name: 'Grafana' },
      ])
    })

    it('registers /proxy/0 through /proxy/15 routes', () => {
      plugin.registerWithRouter!(mockRouter)
      for (let i = 0; i < 16; i++) {
        expect(mockRouter.use).toHaveBeenCalledWith(`/proxy/${i}`, expect.any(Function))
      }
    })

    it('strips invalid header names before invoking the proxy', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/0')!
      const mockReq = {
        headers: {
          'content-type': 'text/html',
          'primus::req::backup': {},
          'x-custom': 'ok',
        },
      } as unknown as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockReq.headers).not.toHaveProperty('primus::req::backup')
      expect(mockReq.headers).toHaveProperty('content-type', 'text/html')
      expect(mockReq.headers).toHaveProperty('x-custom', 'ok')
    })

    it('returns 503 when plugin is not started', () => {
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/0')!
      const mockReq = {} as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(503)
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Plugin is not started' })
    })

    it('delegates /proxy/0 to proxies[0] when started with one app', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/0')!
      const mockReq = {} as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(dummyProxy).toHaveBeenCalledWith(mockReq, mockRes, mockNext)
    })

    it('delegates /proxy/1 to proxies[1] when started with two apps', () => {
      const proxy0: MockProxyMiddleware = jest.fn()
      const proxy1: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValueOnce(proxy0).mockReturnValueOnce(proxy1)

      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://host-a:8080' },
            { name: 'B', url: 'http://host-b:3000' },
          ],
        },
        jest.fn(),
      )
      plugin.registerWithRouter!(mockRouter)

      const handler1 = registeredHandlers.get('/proxy/1')!
      const mockReq = {} as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler1(mockReq, mockRes, mockNext)

      expect(proxy1).toHaveBeenCalledWith(mockReq, mockRes, mockNext)
      expect(proxy0).not.toHaveBeenCalled()
    })

    it('/proxy/1 returns 404 when only one app is configured', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/1')!
      const mockReq = {} as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(404)
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'No app configured at slot 1' })
    })

    it('returns 503 after plugin is stopped', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)
      void plugin.stop()

      const handler = registeredHandlers.get('/proxy/0')!
      const mockReq = {} as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(503)
    })
  })

  describe('WebSocket upgrade handling', () => {
    let mockServer: EventEmitter
    let dummyProxy: MockProxyMiddleware
    let appWithServer: ServerAPIWithServer

    beforeEach(() => {
      mockServer = new EventEmitter()
      appWithServer = {
        server: mockServer as unknown as Server,
        error: jest.fn(),
      } as unknown as ServerAPIWithServer
      dummyProxy = jest.fn() as MockProxyMiddleware
      dummyProxy.upgrade = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)
    })

    it('registers upgrade handler on server when server is available', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      expect(mockServer.listenerCount('upgrade')).toBe(1)
    })

    it('forwards upgrade requests matching plugin path and strips prefix', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-web-proxy/proxy/0/api/websocket/exec',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/api/websocket/exec')
    })

    it('routes upgrade to correct proxy by index', () => {
      const proxy0: MockProxyMiddleware = jest.fn()
      proxy0.upgrade = jest.fn()
      const proxy1: MockProxyMiddleware = jest.fn()
      proxy1.upgrade = jest.fn()
      mockCreateProxyMiddleware.mockReturnValueOnce(proxy0).mockReturnValueOnce(proxy1)

      const plugin = pluginFactory(appWithServer)
      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://host-a:8080' },
            { name: 'B', url: 'http://host-b:3000' },
          ],
        },
        jest.fn(),
      )

      const mockReq = {
        url: '/plugins/signalk-web-proxy/proxy/1/api/websocket/exec',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(proxy1.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(proxy0.upgrade).not.toHaveBeenCalled()
      expect(mockReq.url).toBe('/api/websocket/exec')
    })

    it('sets url to / when upgrade request matches only prefix', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-web-proxy/proxy/0',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/')
    })

    it('strips invalid header names before forwarding upgrade requests', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-web-proxy/proxy/0/api/websocket/exec',
        headers: {
          upgrade: 'websocket',
          'primus::req::backup': {},
          connection: 'Upgrade',
        },
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(mockReq.headers).not.toHaveProperty('primus::req::backup')
      expect(mockReq.headers).toHaveProperty('upgrade', 'websocket')
      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
    })

    it('ignores upgrade requests not matching plugin path', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = { url: '/signalk/v1/stream' } as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
    })

    it('ignores upgrade requests with non-numeric index', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-web-proxy/proxy/0abc/api/websocket/exec',
      } as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
    })

    it('ignores upgrade requests with out-of-range index', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn()) // only 1 app → index 0 valid, index 1 invalid

      const mockReq = {
        url: '/plugins/signalk-web-proxy/proxy/1/api/websocket/exec',
      } as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
    })

    it('removes upgrade handler on stop', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      expect(mockServer.listenerCount('upgrade')).toBe(1)

      void plugin.stop()

      expect(mockServer.listenerCount('upgrade')).toBe(0)
    })

    it('does not register upgrade handler when no apps are configured', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start({ apps: [] }, jest.fn())

      expect(mockServer.listenerCount('upgrade')).toBe(0)
    })

    it('does not invoke proxy upgrade when app.server is unavailable', () => {
      // mockApp has no server property; no listener is registered so upgrade is never dispatched
      const plugin = pluginFactory(mockApp)
      plugin.start(oneApp(), jest.fn())

      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
    })

    it('re-starting replaces the upgrade listener instead of leaking the previous one', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())
      expect(mockServer.listenerCount('upgrade')).toBe(1)

      // Second start (e.g. config save) must not accumulate listeners
      plugin.start(oneApp(), jest.fn())
      expect(mockServer.listenerCount('upgrade')).toBe(1)
    })
  })

  describe('proxy error handling', () => {
    it('configures an error handler on the proxy', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      expect(on['error']).toBeDefined()
      expect(typeof on['error']).toBe('function')
    })

    it('error handler returns 502 without leaking details', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const errorHandler = on['error'] as (err: Error, req: Request, res: Response) => void

      const mockReq = {} as Request
      const mockRes = {
        headersSent: false,
        writeHead: jest.fn(),
        end: jest.fn(),
      } as unknown as Response

      errorHandler(new Error('ECONNREFUSED'), mockReq, mockRes)

      expect(mockError).toHaveBeenCalledWith('Web proxy error: ECONNREFUSED')
      expect(mockRes.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json' })
      const body = JSON.parse((mockRes.end as jest.Mock).mock.calls[0][0] as string) as Record<
        string,
        unknown
      >
      expect(body['error']).toBe('Application is not reachable')
      expect(body).not.toHaveProperty('detail')
    })

    it('error handler does not write headers if already sent', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const errorHandler = on['error'] as (err: Error, req: Request, res: Response) => void

      const mockReq = {} as Request
      const mockRes = {
        headersSent: true,
        writeHead: jest.fn(),
        end: jest.fn(),
      } as unknown as Response

      errorHandler(new Error('timeout'), mockReq, mockRes)

      expect(mockError).toHaveBeenCalledWith('Web proxy error: timeout')
      expect(mockRes.writeHead).not.toHaveBeenCalled()
      expect(mockRes.end).toHaveBeenCalledWith() // no body — avoids corrupting partial response
    })

    it('error handler destroys socket for WebSocket errors', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const errorHandler = on['error'] as (
        err: Error,
        req: Request,
        res: { destroy: () => void },
      ) => void

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Socket } = require('net') as typeof import('net')
      const mockSocket = new Socket()
      mockSocket.destroy = jest.fn() as typeof mockSocket.destroy

      errorHandler(new Error('ws error'), {} as Request, mockSocket)

      expect(mockError).toHaveBeenCalledWith('Web proxy error: ws error')
      expect(mockSocket.destroy).toHaveBeenCalled()
    })
  })
})
