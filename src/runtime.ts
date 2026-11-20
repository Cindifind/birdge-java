import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Bot, Context, Session } from '@luckylillia/plugin-sdk'
import { DEFAULT_BRIDGE_JAR, DEFAULT_JAVA_PLUGIN_DIR, JniBridge } from './bridge.js'
import type { OB11Event } from './convert.js'
import { toInternalMethod, toOneBotEvent } from './convert.js'
import type { CallActionNotificationParams, InitParams, InitResult, JavaPluginInfo } from './protocol.js'
import type { JavaBridgeConfig } from './settings.js'

/** The NTQQ protocol plugin's message cache; not part of the plugin SDK. */
interface MessageStore {
  getMsgBySeq?(peerUid: string, msgSeq: number): RawMessageLike | undefined
  createMsgShortId?(message: RawMessageLike): number
}

interface RawMessageLike {
  msgId: string
  msgSeq: number
  msgRandom: number
  peerUid: string
  senderUid: string
  chatType: number
}

/** One account, as the WebUI page lists them. */
export interface BotAccount {
  sid: string
  platform: string
  selfId: string
  name?: string
}

/** What the WebUI page shows. */
export interface JavaBridgeStatus {
  running: boolean
  starting: boolean
  error: string
  javaPath: string
  bridgeJar: string
  bridgeJarExists: boolean
  javaPluginDir: string
  dataPath: string
  plugins: JavaPluginInfo[]
  bots: BotAccount[]
}

/**
 * Runs the Java process and feeds it OneBot 11: events come from `bot/session` (converted in convert.ts),
 * actions go back through the bot's `internal`, which is the OneBot 11 action set of the QQ account.
 */
export class JavaBridgeRuntime {
  private bridge: JniBridge | null = null
  private plugins: JavaPluginInfo[] = []
  private starting: Promise<void> | null = null
  private error = ''
  private disposed = false

  constructor(private readonly ctx: Context, private readonly config: JavaBridgeConfig) {}

  get running(): boolean {
    return this.bridge?.running ?? false
  }

  /** The bot's data directory: where `data/java-plugins` and the Java plugins' own files live. */
  get dataPath(): string {
    return path.resolve('data')
  }

  /** The bridge jar: a configured path, else the copy shipped beside lib/ in this package. */
  get bridgeJar(): string {
    const name = this.config.bridgeJar?.trim() || DEFAULT_BRIDGE_JAR
    if (path.isAbsolute(name)) return name
    const base = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.join(base, name),
      path.join(base, '..', name),
      path.resolve(name),
    ]
    return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0]
  }

  /** The Java plugin directory: an absolute path, else relative to the data directory. */
  get javaPluginDir(): string {
    const configured = this.config.javaPluginDir?.trim() || DEFAULT_JAVA_PLUGIN_DIR
    return path.isAbsolute(configured) ? configured : path.resolve(this.dataPath, configured)
  }

  status(): JavaBridgeStatus {
    const jar = this.bridgeJar
    return {
      running: this.running,
      starting: this.starting != null,
      error: this.error,
      javaPath: this.config.javaPath?.trim() || 'java',
      bridgeJar: jar,
      bridgeJarExists: fs.existsSync(jar),
      javaPluginDir: this.javaPluginDir,
      dataPath: this.dataPath,
      plugins: this.plugins,
      bots: this.accounts(),
    }
  }

  /** Starts the Java process and hands it the plugin directory; a failure is kept for the WebUI page. */
  async start(): Promise<void> {
    if (this.disposed) return
    if (this.running) return
    if (this.starting) return this.starting
    this.starting = this.doStart()
    try {
      await this.starting
      this.error = ''
    } catch (e) {
      this.error = errorMessage(e)
      this.ctx.logger.error(`[java-bridge] ${this.error}`)
    } finally {
      this.starting = null
    }
  }

  private async doStart(): Promise<void> {
    const jar = this.bridgeJar
    if (!fs.existsSync(jar)) {
      throw new Error(`找不到桥接 JAR：${jar}（把 onebot-bridge.jar 放回插件目录，或在设置里写绝对路径）`)
    }

    const pluginDir = this.javaPluginDir
    fs.mkdirSync(pluginDir, { recursive: true })

    const javaPath = this.config.javaPath?.trim() || 'java'
    const jvmArgs = listOf(this.config.jvmArgs)
    const classpath = listOf(this.config.classpath)
      .map(entry => (path.isAbsolute(entry) ? entry : path.resolve(entry)))
    const logger = this.ctx.logger('java-bridge')

    const bridge = new JniBridge({
      javaPath,
      jvmArgs,
      bridgeJar: jar,
      classpath,
      callTimeout: Number(this.config.callTimeout) || 30_000,
      logger,
    })

    bridge.on('action', (params) => { void this.handleAction(bridge, params) })
    bridge.on('event', event => logger.debug('Java plugin emitted an event, ignored:', event))
    bridge.on('exit', (code, signal) => {
      if (this.bridge !== bridge) return
      this.bridge = null
      this.plugins = []
      this.error = `Java 进程已退出（code=${code}, signal=${signal}）`
      logger.warn(this.error)
    })

    this.bridge = bridge
    try {
      await bridge.start()
      if (this.disposed) {
        await bridge.destroy()
        return
      }
      const initParams: InitParams = {
        dataPath: this.dataPath,
        javaPluginPath: pluginDir,
        adapterName: 'luckylillia-java-bridge',
        javaPath,
        jvmArgs,
        bridgeJar: jar,
        classpath,
      }
      const info = await bridge.call<InitResult>('init', initParams)
      this.plugins = info?.plugins ?? []
      logger.info(`Java 插件桥接已就绪，已加载 ${this.plugins.length} 个 Java 插件`)
    } catch (e) {
      if (this.bridge === bridge) this.bridge = null
      this.plugins = []
      await bridge.destroy().catch(() => void 0)
      throw e
    }
  }

  async stop(): Promise<void> {
    const bridge = this.bridge
    this.bridge = null
    this.plugins = []
    if (!bridge) return
    try {
      await bridge.destroy()
    } catch (e) {
      this.ctx.logger.warn('[java-bridge] 停止 Java 进程时出错:', e)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  /** Stops the Java process and starts it again: rescans the plugin directory. */
  async reload(): Promise<JavaBridgeStatus> {
    if (this.disposed) return this.status()
    // A start still in flight would otherwise be joined instead of replaced
    if (this.starting) await this.starting.catch(() => void 0)
    await this.stop()
    await this.start()
    return this.status()
  }

  /** Rescans the Java plugin directory. */
  async listPlugins(): Promise<JavaPluginInfo[]> {
    if (!this.bridge?.running) return this.plugins
    const info = await this.bridge.call<InitResult>('listPlugins', {})
    this.plugins = info?.plugins ?? this.plugins
    return this.plugins
  }

  async loadPlugin(pluginId: string): Promise<JavaPluginInfo[]> {
    const bridge = this.requireBridge()
    await bridge.call('loadPlugin', { pluginId })
    return this.listPlugins()
  }

  async unloadPlugin(pluginId: string): Promise<JavaPluginInfo[]> {
    const bridge = this.requireBridge()
    await bridge.call('unloadPlugin', { pluginId })
    return this.listPlugins()
  }

  /** The account actions go through: the configured one, else the first QQ account logged in. */
  defaultBot(): Bot | undefined {
    const bots = this.ctx.bots
    const sid = this.config.botSid?.trim()
    if (sid) return bots.get(sid) ?? bots.get(normalizeSid(sid))
    for (const bot of bots) {
      if (isNtqq(bot.platform)) return bot
    }
    return
  }

  /** `bot/session`: every neutral event, turned into the OneBot 11 shapes a Java plugin reads. */
  handleSession(session: Session): void {
    const bridge = this.bridge
    if (!bridge?.running) {
      this.ctx.logger.debug(`[java-bridge] Java 桥接进程未运行，已忽略 ${session.type} 事件`)
      return
    }
    if (!isNtqq(session.platform)) {
      this.ctx.logger.debug(`[java-bridge] 平台 ${session.platform} 不是 QQ 账号，已忽略 ${session.type} 事件`)
      return
    }
    // One Java process serves one account: the action calls it makes have no account to carry
    if (session.bot.sid !== this.defaultBot()?.sid) {
      this.ctx.logger.debug(`[java-bridge] 账号 ${session.bot.sid} 不是桥接账号，已忽略 ${session.type} 事件`)
      return
    }
    if (!this.config.reportSelfMessage && isSelf(session)) return

    let event: OB11Event | undefined
    try {
      event = toOneBotEvent(session, { messageId: raw => this.messageShortId(raw) })
    } catch (e) {
      this.ctx.logger.warn('[java-bridge] 转换中立事件时出错:', e)
      return
    }
    if (!event) return

    try {
      if (event.post_type === 'message' || event.post_type === 'message_sent') {
        // A message with nothing in it (a recalled card and the like) is of no use to a Java plugin
        if (!Array.isArray(event.message) || event.message.length === 0) return
        this.ctx.logger.debug(`[java-bridge] 收到消息：${messageSummary(event)}`)
        bridge.notify('onMessage', { event })
      } else {
        bridge.notify('onEvent', { event })
      }
    } catch (e) {
      this.ctx.logger.warn('[java-bridge] 转发事件到 Java 失败:', e)
    }
  }

  /** An action a Java plugin asked for, run as the OneBot 11 action of the same name. */
  private async handleAction(bridge: JniBridge, params: CallActionNotificationParams): Promise<void> {
    const { requestId, action } = params
    try {
      const bot = this.defaultBot()
      if (!bot) throw new Error('没有已登录的 QQ 账号，Java 插件暂时无法调用 OneBot API')
      const internal = ntqqInternal(bot)
      if (!internal) throw new Error(`账号 ${bot.sid} 不是 QQ 账号`)

      const method = toInternalMethod(String(action ?? ''))
      const handler = (internal as unknown as Record<string, unknown>)[method]
      if (typeof handler !== 'function') throw new Error(`不支持的 OneBot Action：${action}`)

      const data = await (handler as (params?: unknown) => Promise<unknown>).call(internal, params.params ?? {})
      bridge.replyAction(requestId, true, data)
    } catch (e) {
      bridge.replyAction(requestId, false, undefined, errorMessage(e))
    }
  }

  /** `<chatType>|<peerUid>|<msgSeq>` as the short id OneBot 11 events carry. */
  private messageShortId(raw: string): number | undefined {
    if (!raw.includes('|')) return
    const [, peerUid, seq] = raw.split('|')
    const store = this.store()
    const message = store?.getMsgBySeq?.(peerUid, Number(seq))
    if (!message) return
    try {
      return store?.createMsgShortId?.(message)
    } catch {
      return
    }
  }

  private store(): MessageStore | undefined {
    try {
      return (this.ctx as unknown as { store?: MessageStore }).store
    } catch {
      return
    }
  }

  private requireBridge(): JniBridge {
    if (!this.bridge?.running) throw new Error('Java 桥接进程未运行，先重载 Java 进程')
    return this.bridge
  }

  private accounts(): BotAccount[] {
    const accounts: BotAccount[] = []
    try {
      for (const bot of this.ctx.bots) {
        if (!isNtqq(bot.platform)) continue
        accounts.push({ sid: bot.sid, platform: bot.platform, selfId: bot.selfId, name: bot.user?.name })
      }
    } catch {
      // bots not ready yet
    }
    return accounts
  }
}

/** 「群 123456，发送者 10001」加 CQ 码内容；过长的截断，免得 debug 日志刷屏。 */
function messageSummary(event: OB11Event): string {
  const scope = event.message_type === 'group'
    ? `群 ${event.group_id}，发送者 ${event.user_id}`
    : `私聊 ${event.user_id}`
  const raw = String(event.raw_message ?? '')
  return `${scope}：${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}`
}

function isSelf(session: Session): boolean {
  const sender = session.event.user?.id
  return sender != null && String(sender) === String(session.selfId)
}

/** NTQQ 的平台名是 ntqq；luckylillia 是它改名前的旧键，宿主仍按 ntqq 处理。 */
function isNtqq(platform: string): boolean {
  return platform === 'ntqq' || platform === 'luckylillia'
}

/** `luckylillia:12345` 是旧写法，换成 `ntqq:12345` 再查一次。 */
function normalizeSid(sid: string): string {
  return sid.startsWith('luckylillia:') ? `ntqq:${sid.slice('luckylillia:'.length)}` : sid
}

/** QQ 账号（ntqq，旧键 luckylillia）的 OneBot 11 接口；其它平台没有。 */
function ntqqInternal(bot: Bot) {
  return isNtqq(bot.platform) ? bot.internal : undefined
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(entry => entry.length > 0)
  if (typeof value === 'string') return value.split(/\s+/).filter(entry => entry.length > 0)
  return []
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
