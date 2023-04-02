import type NextServer from '../next-server'
import { genExecArgv, getNodeOptionsWithoutInspect } from './utils'
import { deserializeErr, errorToJSON } from '../render'

// we can't use process.send as jest-worker relies on
// it already and can cause unexpected message errors
// so we create an IPC server for communicating
export async function createIpcServer(
  server: InstanceType<typeof NextServer>
): Promise<{
  ipcPort: number
  ipcServer: import('http').Server
}> {
  const ipcServer = (require('http') as typeof import('http')).createServer(
    async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://n')
        const method = url.searchParams.get('method')
        const args: any[] = JSON.parse(url.searchParams.get('args') || '[]')

        if (!method || !Array.isArray(args)) {
          return res.end()
        }

        if (typeof (server as any)[method] === 'function') {
          if (method === 'logErrorWithOriginalStack' && args[0]?.stack) {
            args[0] = deserializeErr(args[0])
          }
          let result = await (server as any)[method](...args)

          if (result && typeof result === 'object' && result.stack) {
            result = errorToJSON(result)
          }
          res.end(JSON.stringify(result || ''))
        }
      } catch (err: any) {
        console.error(err)
        res.end(
          JSON.stringify({
            err: { name: err.name, message: err.message, stack: err.stack },
          })
        )
      }
    }
  )

  const ipcPort = await new Promise<number>((resolveIpc) => {
    ipcServer.listen(0, server.hostname, () => {
      const addr = ipcServer.address()

      if (addr && typeof addr === 'object') {
        resolveIpc(addr.port)
      }
    })
  })

  return {
    ipcPort,
    ipcServer,
  }
}

export const createWorker = (
  serverPort: number,
  ipcPort: number,
  isNodeDebugging: boolean | 'brk' | undefined,
  type: string
) => {
  const { initialEnv } = require('@next/env') as typeof import('@next/env')
  const { Worker } = require('next/dist/compiled/jest-worker')
  const worker = new Worker(require.resolve('./render-server'), {
    numWorkers: 1,
    // TODO: do we want to allow more than 10 OOM restarts?
    maxRetries: 10,
    forkOptions: {
      env: {
        FORCE_COLOR: '1',
        ...initialEnv,
        // we don't pass down NODE_OPTIONS as it can
        // extra memory usage
        NODE_OPTIONS: getNodeOptionsWithoutInspect()
          .replace(/--max-old-space-size=[\d]{1,}/, '')
          .trim(),
        __NEXT_PRIVATE_RENDER_WORKER: type,
        __NEXT_PRIVATE_ROUTER_IPC_PORT: ipcPort + '',
        NODE_ENV: process.env.NODE_ENV,
      },
      execArgv: genExecArgv(
        isNodeDebugging === undefined ? false : isNodeDebugging,
        (serverPort || 0) + 1
      ),
    },
    exposedMethods: ['initialize', 'deleteCache', 'deleteAppClientCache'],
  }) as any as InstanceType<typeof Worker> & {
    initialize: typeof import('./render-server').initialize
    deleteCache: typeof import('./render-server').deleteCache
    deleteAppClientCache: typeof import('./render-server').deleteAppClientCache
  }

  worker.getStderr().pipe(process.stderr)
  worker.getStdout().pipe(process.stdout)

  return worker
}
