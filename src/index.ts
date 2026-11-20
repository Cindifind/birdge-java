import type { Context } from '@luckylillia/plugin-sdk'
import { createJavaBridgeRoutes } from './routes.js'
import { JavaBridgeRuntime } from './runtime.js'
import { Config } from './settings.js'
import type { JavaBridgeConfig } from './settings.js'

export { Config }
export type { JavaBridgeConfig }

export const name = 'java-bridge'

export const inject = ['bots']

/**
 * Java 插件桥接：把自己的 Java 插件（.jar）放进 data/java-plugins，插件启动时拉起一个 Java 进程，
 * 把 QQ 账号收到的 OneBot 11 事件推给它，Java 插件也能反向调用 OneBot 11 的 API。
 */
export function apply(ctx: Context, config: JavaBridgeConfig) {
  const runtime = new JavaBridgeRuntime(ctx, config)

  ctx.effect(() => {
    void runtime.start()
    return () => runtime.dispose()
  })

  ctx.on('bot/session', session => runtime.handleSession(session))

  // The WebUI half is optional: on a headless bot the bridge still runs
  ctx.inject(['webuiServer'], (ctx) => {
    ctx.webuiServer.route('/api/java-bridge', createJavaBridgeRoutes(runtime))
  })
}
