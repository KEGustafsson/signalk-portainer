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

describe('signalk-portainer plugin', () => {
  let plugin: Plugin

  beforeEach(() => {
    jest.clearAllMocks()
    plugin = pluginFactory(mockApp)
  })

  describe('metadata', () => {
    it('has the correct plugin id', () => {
      expect(plugin.id).toBe('signalk-portainer')
    })

    it('has the correct plugin name', () => {
      expect(plugin.name).toBe('Portainer CE')
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

    it('defines portainerHost property with default', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      expect(properties['portainerHost']).toBeDefined()
      expect(properties['portainerHost']!['type']).toBe('string')
      expect(properties['portainerHost']!['default']).toBe('127.0.0.1')
    })

    it('defines portainerPort property with default and constraints', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      expect(properties['portainerPort']).toBeDefined()
      expect(properties['portainerPort']!['type']).toBe('integer')
      expect(properties['portainerPort']!['default']).toBe(9000)
      expect(properties['portainerPort']!['minimum']).toBe(1)
      expect(properties['portainerPort']!['maximum']).toBe(65535)
    })

    it('defines portainerScheme property with enum', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      expect(properties['portainerScheme']).toBeDefined()
      expect(properties['portainerScheme']!['type']).toBe('string')
      expect(properties['portainerScheme']!['default']).toBe('http')
      expect(properties['portainerScheme']!['enum']).toEqual(['http', 'https'])
    })

    it('defines allowSelfSigned property with default false', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      expect(properties['allowSelfSigned']).toBeDefined()
      expect(properties['allowSelfSigned']!['type']).toBe('boolean')
      expect(properties['allowSelfSigned']!['default']).toBe(false)
    })
  })

  describe('start/stop lifecycle', () => {
    const dummyProxy: MockProxyMiddleware = jest.fn()

    beforeEach(() => {
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)
    })

    it('creates proxy middleware with correct target on start', () => {
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(1)
      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000')
      expect(options['changeOrigin']).toBe(true)
      expect(options['ws']).toBe(true)
    })

    it('uses custom host and port from config', () => {
      plugin.start({ portainerHost: '192.168.1.100', portainerPort: 9443 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://192.168.1.100:9443')
    })

    it('uses default values when config is empty', () => {
      plugin.start({}, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://127.0.0.1:9000')
    })

    it('uses default values for invalid config values', () => {
      plugin.start({ portainerHost: '', portainerPort: -1 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://127.0.0.1:9000')
    })

    it('rejects hosts with URL metacharacters', () => {
      plugin.start({ portainerHost: 'evil.com/path', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://127.0.0.1:9000')
    })

    it('rejects cloud metadata host addresses', () => {
      plugin.start({ portainerHost: '169.254.169.254', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://127.0.0.1:9000')
    })

    it('rejects hosts with special characters', () => {
      plugin.start({ portainerHost: 'user:pass@evil.com', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://127.0.0.1:9000')
    })

    it('normalizes host to lowercase', () => {
      plugin.start({ portainerHost: 'MyHost.Local', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://myhost.local:9000')
    })

    it('strips trailing dots from host', () => {
      plugin.start({ portainerHost: 'myhost.local.', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://myhost.local:9000')
    })

    it('rejects cloud metadata host with trailing dot', () => {
      plugin.start({ portainerHost: '169.254.169.254.', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://127.0.0.1:9000')
    })

    it('rejects cloud metadata host with mixed case', () => {
      plugin.start({ portainerHost: 'Metadata.Google.Internal', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://127.0.0.1:9000')
    })

    it('uses https scheme when configured', () => {
      plugin.start(
        { portainerHost: 'localhost', portainerPort: 9443, portainerScheme: 'https' },
        jest.fn(),
      )

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('https://localhost:9443')
      expect(options['secure']).toBe(true)
    })

    it('sets secure to false when allowSelfSigned is true with https', () => {
      plugin.start(
        {
          portainerHost: 'localhost',
          portainerPort: 9443,
          portainerScheme: 'https',
          allowSelfSigned: true,
        },
        jest.fn(),
      )

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('https://localhost:9443')
      expect(options['secure']).toBe(false)
    })

    it('configures a proxyReq handler that sets forwarding headers', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      expect(on['proxyReq']).toBeDefined()
      expect(typeof on['proxyReq']).toBe('function')

      const proxyReqHandler = on['proxyReq'] as (
        proxyReq: { setHeader: jest.Mock },
        req: unknown,
      ) => void

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

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const proxyReqHandler = on['proxyReq'] as (
        proxyReq: { setHeader: jest.Mock },
        req: unknown,
      ) => void

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

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const proxyReqHandler = on['proxyReq'] as (
        proxyReq: { setHeader: jest.Mock },
        req: unknown,
      ) => void

      const mockProxyReq = { setHeader: jest.fn() }
      // socket is NOT encrypted but upstream already set x-forwarded-proto: https
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

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const proxyReqHandler = on['proxyReq'] as (
        proxyReq: { setHeader: jest.Mock },
        req: unknown,
      ) => void

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
      plugin.start(
        { portainerHost: 'localhost', portainerPort: 9000, allowSelfSigned: true },
        jest.fn(),
      )

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000')
      expect(options['secure']).toBe(true)
    })

    it('falls back to http for invalid scheme values', () => {
      plugin.start(
        { portainerHost: 'localhost', portainerPort: 9000, portainerScheme: 'ftp' },
        jest.fn(),
      )

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000')
    })

    it('rejects non-integer port numbers', () => {
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000.5 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000')
    })

    it('cleans up on stop', () => {
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())
      void plugin.stop()

      expect(plugin.statusMessage?.()).toBe('Not started')
    })
  })

  describe('statusMessage', () => {
    beforeEach(() => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
    })

    it('returns not started before start is called', () => {
      expect(plugin.statusMessage?.()).toBe('Not started')
    })

    it('returns target info after start', () => {
      plugin.start({ portainerHost: 'myhost', portainerPort: 8080 }, jest.fn())
      expect(plugin.statusMessage?.()).toBe('Proxying to http://myhost:8080')
    })

    it('returns not started after stop', () => {
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())
      void plugin.stop()
      expect(plugin.statusMessage?.()).toBe('Not started')
    })
  })

  describe('registerWithRouter', () => {
    let mockRouter: IRouter
    let registeredHandlers: Map<string, MiddlewareFn>

    beforeEach(() => {
      registeredHandlers = new Map()
      mockRouter = {
        use: jest.fn((path: string, handler: MiddlewareFn) => {
          registeredHandlers.set(path, handler)
          return mockRouter
        }),
      } as unknown as IRouter
    })

    it('registers middleware on /proxy and / routes', () => {
      plugin.registerWithRouter!(mockRouter)
      expect(mockRouter.use).toHaveBeenCalledWith('/proxy', expect.any(Function))
      expect(mockRouter.use).toHaveBeenCalledWith('/', expect.any(Function))
    })

    it('registers /proxy before / to take priority', () => {
      plugin.registerWithRouter!(mockRouter)
      const calls = (mockRouter.use as jest.Mock).mock.calls as [string, MiddlewareFn][]
      const paths = calls.map((c) => c[0])
      expect(paths).toEqual(['/proxy', '/'])
    })

    it('strips invalid header names before invoking the proxy', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy')!
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

      const handler = registeredHandlers.get('/proxy')!
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

    it('delegates to proxy when plugin is started', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy')!
      const mockReq = {} as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(dummyProxy).toHaveBeenCalledWith(mockReq, mockRes, mockNext)
    })

    it('returns 503 after plugin is stopped', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())
      plugin.registerWithRouter!(mockRouter)
      void plugin.stop()

      const handler = registeredHandlers.get('/proxy')!
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
      appWithServer = { server: mockServer as unknown as Server } as ServerAPIWithServer
      dummyProxy = jest.fn() as MockProxyMiddleware
      dummyProxy.upgrade = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)
    })

    it('registers upgrade handler on server when server is available', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      expect(mockServer.listenerCount('upgrade')).toBe(1)
    })

    it('forwards upgrade requests matching plugin path and strips prefix', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const mockReq = { url: '/plugins/signalk-portainer/api/websocket/exec' } as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/api/websocket/exec')
    })

    it('strips /proxy subpath from upgrade requests', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const mockReq = {
        url: '/plugins/signalk-portainer/proxy/api/websocket/exec',
      } as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/api/websocket/exec')
    })

    it('sets url to / when upgrade request matches only prefix', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const mockReq = { url: '/plugins/signalk-portainer/proxy' } as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/')
    })

    it('strips invalid header names before forwarding upgrade requests', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const mockReq = {
        url: '/plugins/signalk-portainer/api/websocket/exec',
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
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const mockReq = { url: '/signalk/v1/stream' } as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
    })

    it('removes upgrade handler on stop', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      expect(mockServer.listenerCount('upgrade')).toBe(1)

      void plugin.stop()

      expect(mockServer.listenerCount('upgrade')).toBe(0)
    })

    it('does not register upgrade handler when server is not available', () => {
      const plugin = pluginFactory(mockApp)
      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      // No error thrown, upgrade simply not wired
      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
    })
  })

  describe('proxy error handling', () => {
    it('configures an error handler on the proxy', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      expect(on['error']).toBeDefined()
      expect(typeof on['error']).toBe('function')
    })

    it('error handler returns 502 without leaking details', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

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

      expect(mockError).toHaveBeenCalledWith('Portainer proxy error: ECONNREFUSED')
      expect(mockRes.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json' })
      const body = JSON.parse((mockRes.end as jest.Mock).mock.calls[0][0] as string) as Record<
        string,
        unknown
      >
      expect(body['error']).toBe('Portainer is not reachable')
      expect(body).not.toHaveProperty('detail')
    })

    it('error handler does not write headers if already sent', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

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

      expect(mockError).toHaveBeenCalledWith('Portainer proxy error: timeout')
      expect(mockRes.writeHead).not.toHaveBeenCalled()
      expect(mockRes.end).toHaveBeenCalled()
    })

    it('error handler destroys socket for WebSocket errors', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())

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

      expect(mockError).toHaveBeenCalledWith('Portainer proxy error: ws error')
      expect(mockSocket.destroy).toHaveBeenCalled()
    })
  })
})
