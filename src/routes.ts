import type { FetchHandler } from '@luckylillia/plugin-sdk'
import type { JavaBridgeRuntime } from './runtime.js'

/**
 * `/api/java-bridge/*`, the API the WebUI page calls: `status`, `reload`, `plugins/load`, `plugins/unload`.
 * Answers in the WebUI's `{ success, data, message }` shape.
 */
export function createJavaBridgeRoutes(runtime: JavaBridgeRuntime): FetchHandler {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url)
      const action = pathname.replace(/^\/api\/java-bridge\/?/, '').replace(/\/+$/, '')
      try {
        switch (action) {
          case '':
          case 'status':
            return reply(true, runtime.status())
          case 'reload':
            return reply(true, await runtime.reload())
          case 'plugins':
            return reply(true, await runtime.listPlugins())
          case 'plugins/load': {
            const body = await readJson(request)
            return reply(true, await runtime.loadPlugin(String(body.id ?? '')))
          }
          case 'plugins/unload': {
            const body = await readJson(request)
            return reply(true, await runtime.unloadPlugin(String(body.id ?? '')))
          }
          default:
            return Response.json({ success: false, message: '接口不存在' }, { status: 404 })
        }
      } catch (e) {
        return Response.json({ success: false, message: e instanceof Error ? e.message : String(e) }, { status: 500 })
      }
    },
  }
}

function reply(success: boolean, data: unknown): Response {
  return Response.json({ success, data })
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}
