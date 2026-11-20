import { Schema } from '@luckylillia/plugin-sdk'

/** What the bridge runs with; the jar and plugin directory are resolved at start, see runtime.ts. */
export interface JavaBridgeConfig {
  /** java 可执行文件，装了 JDK / JRE 且加进了 PATH 就留 java */
  javaPath: string
  /** JVM 启动参数 */
  jvmArgs: string[]
  /** 桥接 JAR：相对路径先找插件目录、再找 Bot 的运行目录；留空就是自带的那份 */
  bridgeJar: string
  /** Java 插件（.jar）目录：相对路径基于 data 目录；留空就是 data/java-plugins */
  javaPluginDir: string
  /** 额外的 classpath（目录或 jar） */
  classpath: string[]
  /** 单次调用的超时时间 */
  callTimeout: number
  /** 把自己发送的消息也发给 Java 插件 */
  reportSelfMessage: boolean
  /** 只桥接这个账号，形如 ntqq:12345（旧写法 luckylillia:12345 也认）；留空用第一个已登录的 QQ 账号（也只桥接它） */
  botSid: string
}

export const DEFAULT_CONFIG: JavaBridgeConfig = {
  javaPath: 'java',
  jvmArgs: ['-Xmx256m'],
  bridgeJar: 'onebot-bridge.jar',
  javaPluginDir: 'java-plugins',
  classpath: [],
  callTimeout: 30_000,
  reportSelfMessage: false,
  botSid: '',
}

// Mirrors what the bridge used to be as part of the OneBot adapter's settings (`ob11.jni`): the Java plugin
// directory stays under the bot's data directory, so an upgrade finds the jars where they always were
export const Config: Schema<JavaBridgeConfig> = Schema.object({
  javaPath: Schema.string().default('java').description('java 可执行文件的路径，装了 JDK / JRE 且加进了 PATH 就留 java'),
  jvmArgs: Schema.array(Schema.string()).default(['-Xmx256m']).description('JVM 启动参数'),
  bridgeJar: Schema.string().default('onebot-bridge.jar')
    .description('桥接 JAR：相对路径先找插件目录、再找 Bot 的运行目录；留空就是自带的那份'),
  javaPluginDir: Schema.string().default('java-plugins')
    .description('Java 插件（.jar）目录：相对路径基于 data 目录；留空就是 data/java-plugins'),
  classpath: Schema.array(Schema.string()).default([]).description('额外的 classpath（目录或 jar）'),
  callTimeout: Schema.natural().role('ms').min(1).default(30_000).description('单次调用的超时时间'),
  reportSelfMessage: Schema.boolean().default(false).description('把自己发送的消息也发给 Java 插件'),
  botSid: Schema.string().default('').description('只桥接这个账号（ntqq:QQ号；旧写法 luckylillia:QQ号 也认）；留空用第一个已登录的 QQ 账号，也只桥接它'),
}) as unknown as Schema<JavaBridgeConfig>
