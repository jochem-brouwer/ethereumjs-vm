import { createServer } from 'http'
import { Server as RPCServer, HttpServer } from 'jayson/promise'
import { json as jsonParser } from 'body-parser'
import { decode, TAlgorithm } from 'jwt-simple'
import Connect, { IncomingMessage } from 'connect'
import cors from 'cors'

const algorithm: TAlgorithm = 'HS256'

type CreateRPCServerListenerOpts = {
  rpcCors?: string
  server: RPCServer
  withEngineMiddleware?: WithEngineMiddleware
}
type WithEngineMiddleware = { jwtSecret: Buffer; unlessFn?: (req: IncomingMessage) => boolean }

function checkHeaderAuth(req: any, jwtSecret: Buffer): void {
  const header = (req.headers['Authorization'] ?? req.headers['authorization']) as string
  if (!header) throw Error(`Missing auth header`)
  const token = header.trim().split(' ')[1]
  if (!token) throw Error(`Missing jwt token`)
  const claims = decode(token.trim(), jwtSecret as never as string, false, algorithm)
  if (Math.abs(new Date().getTime() - claims.iat * 1000 ?? 0) > 5000) {
    throw Error('Stale jwt token')
  }
}

export function createRPCServerListener(opts: CreateRPCServerListenerOpts): HttpServer {
  const { server, withEngineMiddleware, rpcCors } = opts

  const app = Connect()
  if (rpcCors) app.use(cors({ origin: rpcCors }))
  // GOSSIP_MAX_SIZE_BELLATRIX is proposed to be 10MiB
  app.use(jsonParser({ limit: '11mb' }))

  if (withEngineMiddleware) {
    const { jwtSecret, unlessFn } = withEngineMiddleware
    app.use(function (req, res, next) {
      try {
        if (unlessFn) {
          if (unlessFn(req)) return next()
        }
        checkHeaderAuth(req, jwtSecret)
        return next()
      } catch (error) {
        if (error instanceof Error) {
          res.writeHead(401)
          res.end(`Unauthorized: ${error}`)
        } else next(error)
      }
    })
  }

  app.use(server.middleware())
  const httpServer = createServer(app)
  return httpServer
}

export function createWsRPCServerListener(
  opts: CreateRPCServerListenerOpts & { httpServer?: HttpServer }
): HttpServer | undefined {
  const { server, withEngineMiddleware, rpcCors } = opts

  // Get the server to hookup upgrade request on
  let httpServer = opts.httpServer
  if (!httpServer) {
    const app = Connect()
    // In case browser pre-flights the upgrade request with an options request
    // more likely in case of wss connection
    if (rpcCors) app.use(cors({ origin: rpcCors }))
    httpServer = createServer(app)
  }

  const wss = server.websocket({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    if (withEngineMiddleware) {
      const { jwtSecret } = withEngineMiddleware
      try {
        checkHeaderAuth(req, jwtSecret)
      } catch (error) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
      }
    }
    ;(wss as any).handleUpgrade(req, socket, head, (ws: any) => {
      ;(wss as any).emit('connection', ws, req)
    })
  })
  // Only return something if a new server was created
  return !opts.httpServer ? httpServer : undefined
}