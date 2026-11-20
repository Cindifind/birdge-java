import type { Session } from '@luckylillia/plugin-sdk'
import type h from '@satorijs/element'

/** OneBot 11 的消息段 */
export interface OB11Segment {
  type: string
  data: Record<string, unknown>
}

/** OneBot 11 的事件：post_type 决定其余字段 */
export interface OB11Event {
  post_type: string
  [key: string]: unknown
}

export interface ConvertOptions {
  /**
   * OneBot 11 的 message_id 是 int32，而中立事件的 id 是 `<chatType>|<peerUid>|<msgSeq>`。
   * 宿主知道消息缓存时给出 int32；返回 undefined 时退回 msgSeq。
   */
  messageId?: (raw: string) => number | undefined
}

/**
 * Turns a neutral event (what `ctx.on('bot/session')` hands out) into the OneBot 11 shape a Java plugin
 * expects. Events without an OneBot counterpart — reactions, internal platform events — are skipped.
 */
export function toOneBotEvent(session: Session, options: ConvertOptions = {}): OB11Event | undefined {
  const selfId = toId(session.selfId)
  const time = Math.floor(session.timestamp / 1000)
  const userId = toId(session.userId)
  const messageId = session.messageId ? resolveMessageId(session.messageId, options) : undefined

  switch (session.type) {
    case 'message-created':
      return messageEvent(session, selfId, time, messageId, userId)
    case 'message-deleted':
      return recallEvent(session, selfId, time, messageId, userId)
    case 'guild-member-added':
    case 'guild-member-removed':
      return memberEvent(session, selfId, time, userId)
    case 'friend-added':
      return {
        post_type: 'notice',
        notice_type: 'friend_add',
        self_id: selfId,
        user_id: userId,
        time,
      }
    case 'friend-request':
      return {
        post_type: 'request',
        request_type: 'friend',
        self_id: selfId,
        user_id: userId,
        comment: session.event.message?.content ?? '',
        // OneBot 的 flag 要原样回传；中立事件的 message.id 正是 internal 认得的那个
        flag: session.messageId ?? '',
        time,
      }
    case 'guild-request':
    case 'guild-member-request':
      return {
        post_type: 'request',
        request_type: 'group',
        sub_type: session.type === 'guild-request' ? 'invite' : 'add',
        self_id: selfId,
        group_id: toId(session.guildId),
        user_id: userId,
        comment: session.event.message?.content ?? '',
        flag: session.messageId ?? '',
        time,
      }
    default:
      return
  }
}

function messageEvent(
  session: Session,
  selfId: number | string | undefined,
  time: number,
  messageId: number | undefined,
  userId: number | string | undefined,
): OB11Event {
  const segments = toSegments(session.elements)
  const messageType = session.isDirect ? 'private' : 'group'
  const groupId = messageType === 'group' ? toId(session.guildId ?? session.channelId) : undefined
  const self = isSelf(session)
  const sender: Record<string, unknown> = {
    user_id: userId,
    nickname: session.event.user?.name ?? '',
  }
  if (messageType === 'group') {
    sender.card = session.event.member?.nick ?? ''
    sender.role = roleOf(session.event.member?.roles)
  }

  const event: OB11Event = {
    post_type: self ? 'message_sent' : 'message',
    self_id: selfId,
    message_type: messageType,
    sub_type: messageType === 'group' ? 'normal' : 'friend',
    message_id: messageId,
    message_seq: seqOf(session.messageId),
    user_id: userId,
    message: segments,
    message_format: 'array',
    raw_message: toCQCode(segments),
    font: 14,
    sender,
    time,
  }
  if (groupId != null) {
    event.group_id = groupId
  }
  if (self) {
    // What OneBot calls the other end of a message one sent: the group, or the friend's uin
    event.target_id = groupId ?? toId(String(session.channelId ?? '').replace(/^private:/, ''))
  }
  return event
}

function recallEvent(
  session: Session,
  selfId: number | string | undefined,
  time: number,
  messageId: number | undefined,
  userId: number | string | undefined,
): OB11Event {
  const groupId = toId(session.guildId)
  if (groupId != null) {
    return {
      post_type: 'notice',
      notice_type: 'group_recall',
      self_id: selfId,
      group_id: groupId,
      user_id: userId,
      operator_id: toId(session.event.operator?.id) ?? userId,
      message_id: messageId,
      time,
    }
  }
  return {
    post_type: 'notice',
    notice_type: 'friend_recall',
    self_id: selfId,
    user_id: userId,
    message_id: messageId,
    time,
  }
}

function memberEvent(
  session: Session,
  selfId: number | string | undefined,
  time: number,
  userId: number | string | undefined,
): OB11Event {
  const increase = session.type === 'guild-member-added'
  return {
    post_type: 'notice',
    notice_type: increase ? 'group_increase' : 'group_decrease',
    // No operator means the member left by themselves; otherwise someone removed them
    sub_type: increase ? 'approve' : (session.event.operator ? 'kick' : 'leave'),
    self_id: selfId,
    group_id: toId(session.guildId),
    user_id: userId,
    operator_id: toId(session.event.operator?.id),
    time,
  }
}

/** `<chatType>|<peerUid>|<msgSeq>` as OneBot knows a message, without the host's short id. */
function seqOf(raw?: string): number | undefined {
  if (!raw) return
  const seq = Number(raw.includes('|') ? raw.split('|')[2] : raw)
  return Number.isSafeInteger(seq) ? seq : undefined
}

function resolveMessageId(raw: string, options: ConvertOptions): number | undefined {
  const resolved = options.messageId?.(raw)
  return resolved != null ? resolved : seqOf(raw)
}

function toId(value: unknown): number | string | undefined {
  if (value == null || value === '') return
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : String(value)
}

function isSelf(session: Session): boolean {
  const sender = session.event.user?.id
  return sender != null && String(sender) === String(session.event.self_id ?? session.selfId)
}

function roleOf(roles?: { id: string, name?: string }[]): 'owner' | 'admin' | 'member' {
  const names = (roles ?? []).map(role => role.name ?? role.id)
  if (names.includes('owner')) return 'owner'
  if (names.includes('admin')) return 'admin'
  return 'member'
}

/** OneBot 11 message segments, in the native type names a Java plugin reads. */
export function toSegments(elements: readonly h[]): OB11Segment[] {
  const segments: OB11Segment[] = []
  for (const element of elements) segments.push(...elementToSegments(element))
  return segments
}

function elementToSegments(element: h): OB11Segment[] {
  const attrs = (element.attrs ?? {}) as Record<string, unknown>
  const children = (element.children ?? []) as h[]
  switch (element.type) {
    case 'text':
      return [textSegment(String(attrs.content ?? ''))]
    case 'at':
      return [{ type: 'at', data: { qq: attrs.type === 'all' ? 'all' : String(attrs.id ?? '') } }]
    case 'img':
    case 'image':
      return [{ type: 'image', data: { file: attrs.src, url: attrs.src } }]
    case 'audio':
      return [{ type: 'record', data: { file: attrs.src, url: attrs.src } }]
    case 'video':
      return [{ type: 'video', data: { file: attrs.src, url: attrs.src } }]
    case 'file':
      return [{ type: 'file', data: { file: attrs.src, url: attrs.src, name: attrs.name } }]
    case 'face':
      return [{ type: 'face', data: { id: String(attrs.id ?? '') } }]
    case 'quote':
      return [{ type: 'reply', data: { id: String(attrs.id ?? '') } }]
    case 'br':
      return [textSegment('\n')]
    case 'p':
      return [...toSegments(children), textSegment('\n')]
    case 'markdown':
      return [{ type: 'markdown', data: { content: textOf(element) } }]
    case 'button':
      return [textSegment(String(attrs.text ?? textOf(element)))]
    case 'button-group':
      return toSegments(children)
    default:
      // Platform cards, market faces and anything newer keep what their text says
      return [textSegment(String(attrs.summary ?? textOf(element)))]
  }
}

function textSegment(text: string): OB11Segment {
  return { type: 'text', data: { text } }
}

function textOf(element: h): string {
  if (element.type === 'text') return String((element.attrs as Record<string, unknown> | undefined)?.content ?? '')
  return ((element.children ?? []) as h[]).map(textOf).join('')
}

/** The CQ code form, for plugins that read `raw_message` instead of the segments. */
export function toCQCode(segments: readonly OB11Segment[]): string {
  return segments.map(segment => {
    if (segment.type === 'text') return cqEscape(String(segment.data.text ?? ''))
    const params = Object.entries(segment.data)
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => `${key}=${cqEscape(String(value))}`)
      .join(',')
    return `[CQ:${segment.type}${params ? ',' + params : ''}]`
  }).join('')
}

function cqEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;')
}

/** `set_group_card` as setGroupCard, `_send_group_notice` as sendGroupNotice — bot.internal's keys. */
export function toInternalMethod(action: string): string {
  return action.replace(/^[._]+/, '').replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}
