import type { Plugin } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'

type MiddlewareFn = (req: Request, res: Response, next: () => void) => void

interface MockProxyMiddleware {
  (...args: Parameters<MiddlewareFn>): void
}

const mockCreateProxyMiddleware = jest.fn<MockProxyMiddleware, []>()

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: (...args: unknown[]) => mockCreateProxyMiddleware(...(args as [])),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pluginFactory = require('../src/index') as () => Plugin

describe('signalk-portainer plugin', () => {
  let plugin: Plugin

  beforeEach(() => {
    jest.clearAllMocks()
    plugin = pluginFactory()
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
      expect(properties['portainerHost']!['default']).toBe('localhost')
    })

    it('defines portainerPort property with default and constraints', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      expect(properties['portainerPort']).toBeDefined()
      expect(properties['portainerPort']!['type']).toBe('number')
      expect(properties['portainerPort']!['default']).toBe(9000)
      expect(properties['portainerPort']!['minimum']).toBe(1)
      expect(properties['portainerPort']!['maximum']).toBe(65535)
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
      expect(options['target']).toBe('http://localhost:9000')
    })

    it('uses default values for invalid config values', () => {
      plugin.start({ portainerHost: '', portainerPort: -1 }, jest.fn())

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
    let registeredHandler: MiddlewareFn | null

    beforeEach(() => {
      registeredHandler = null
      mockRouter = {
        use: jest.fn((_path: string, handler: MiddlewareFn) => {
          registeredHandler = handler
          return mockRouter
        }),
      } as unknown as IRouter
    })

    it('registers a middleware on the router', () => {
      plugin.registerWithRouter!(mockRouter)
      expect(mockRouter.use).toHaveBeenCalledWith('/', expect.any(Function))
    })

    it('returns 503 when plugin is not started', () => {
      plugin.registerWithRouter!(mockRouter)

      const mockReq = {} as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      registeredHandler!(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(503)
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Plugin is not started' })
    })

    it('delegates to proxy when plugin is started', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const mockReq = {} as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      registeredHandler!(mockReq, mockRes, mockNext)

      expect(dummyProxy).toHaveBeenCalledWith(mockReq, mockRes, mockNext)
    })

    it('returns 503 after plugin is stopped', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start({ portainerHost: 'localhost', portainerPort: 9000 }, jest.fn())
      plugin.registerWithRouter!(mockRouter)
      void plugin.stop()

      const mockReq = {} as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      registeredHandler!(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(503)
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

    it('error handler returns 502 with details', () => {
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

      expect(mockRes.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json' })
      expect(mockRes.end).toHaveBeenCalledWith(
        JSON.stringify({ error: 'Portainer is not reachable', detail: 'ECONNREFUSED' }),
      )
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

      expect(mockRes.writeHead).not.toHaveBeenCalled()
      expect(mockRes.end).toHaveBeenCalled()
    })
  })
})
