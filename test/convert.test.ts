import { describe, expect, it } from 'vitest'
import type { Session } from '@luckylillia/plugin-sdk'
import type h from '@satorijs/element'
import { toCQCode, toInternalMethod, toOneBotEvent, toSegments } from '../src/convert'

const SELF_ID = '10000'

function element(type: string, attrs: Record<string, unknown> = {}, children: h[] = []): h {
  return { type, attrs, data: attrs, children } as unknown as h
}

function text(content: string): h {
  return element('text', { content })
}

interface SessionOptions {
  type: string
  event?: Record<string, unknown>
  elements?: h[]
  isDirect?: boolean
  userId?: string
  guildId?: string
  channelId?: string
  messageId?: string
  timestamp?: number
}

function session(options: SessionOptions): Session {
  const timestamp = options.timestamp ?? 1_700_000_000_000
  const type = options.type
  return {
    bot: { platform: 'luckylillia', sid: `luckylillia:${SELF_ID}`, selfId: SELF_ID },
    event: {
      type,
      platform: 'luckylillia',
      self_id: SELF_ID,
      timestamp,
      ...options.event,
    },
    type,
    platform: 'luckylillia',
    selfId: SELF_ID,
    timestamp,
    userId: options.userId,
    guildId: options.guildId,
    channelId: options.channelId,
    messageId: options.messageId,
    isDirect: options.isDirect ?? false,
    content: '',
    elements: options.elements ?? [],
    stripped: { content: '', atSelf: false },
  } as unknown as Session
}

function groupMessage(overrides: Partial<SessionOptions> = {}): Session {
  return session({
    type: 'message-created',
    userId: '12345',
    guildId: '67890',
    channelId: '67890',
    messageId: '2|peer-uid|42',
    elements: [text('你好')],
    event: {
      user: { id: '12345', name: '群友' },
      member: { nick: '群名片', roles: [{ id: '3', name: 'admin' }] },
      message: { id: '2|peer-uid|42', content: '你好' },
    },
    ...overrides,
  })
}

describe('toOneBotEvent', () => {
  it('turns a group message into a OneBot 11 message event', () => {
    const event = toOneBotEvent(groupMessage())
    expect(event).toMatchObject({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      user_id: 12345,
      group_id: 67890,
      message_id: 42,
      message_seq: 42,
      raw_message: '你好',
      message_format: 'array',
      font: 14,
      time: 1_700_000_000,
      sender: { user_id: 12345, nickname: '群友', card: '群名片', role: 'admin' },
    })
    expect(event?.message).toEqual([{ type: 'text', data: { text: '你好' } }])
  })

  it('marks the account\'s own messages as message_sent', () => {
    const event = toOneBotEvent(groupMessage({ event: { user: { id: SELF_ID, name: '我' } } }))
    expect(event?.post_type).toBe('message_sent')
  })

  it('gives a message one sent the target it went to', () => {
    const group = toOneBotEvent(groupMessage({ event: { user: { id: SELF_ID, name: '我' } } }))
    expect(group?.target_id).toBe(67890)

    const friend = toOneBotEvent(session({
      type: 'message-created',
      isDirect: true,
      userId: '12345',
      channelId: 'private:54321',
      messageId: '1|friend-uid|7',
      elements: [text('hi')],
      event: { user: { id: SELF_ID, name: '我' } },
    }))
    expect(friend).toMatchObject({ post_type: 'message_sent', target_id: 54321 })
  })

  it('uses the short id the host hands out for message_id', () => {
    const event = toOneBotEvent(groupMessage(), { messageId: () => 987654321 })
    expect(event?.message_id).toBe(987654321)
    expect(event?.message_seq).toBe(42)
  })

  it('turns a private message into a friend message', () => {
    const event = toOneBotEvent(session({
      type: 'message-created',
      isDirect: true,
      userId: '12345',
      messageId: '1|friend-uid|7',
      elements: [text('hi')],
      event: { user: { id: '12345', name: '好友' } },
    }))
    expect(event).toMatchObject({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 12345 })
    expect(event?.group_id).toBeUndefined()
    expect(event?.sender).toEqual({ user_id: 12345, nickname: '好友' })
  })

  it('maps a recall to group_recall or friend_recall', () => {
    const group = toOneBotEvent(session({
      type: 'message-deleted',
      userId: '12345',
      guildId: '67890',
      messageId: '2|peer-uid|42',
      event: { user: { id: '12345' }, operator: { id: '999' } },
    }))
    expect(group).toMatchObject({ post_type: 'notice', notice_type: 'group_recall', group_id: 67890, operator_id: 999 })

    const friend = toOneBotEvent(session({
      type: 'message-deleted',
      userId: '12345',
      messageId: '1|friend-uid|7',
      event: { user: { id: '12345' } },
    }))
    expect(friend).toMatchObject({ post_type: 'notice', notice_type: 'friend_recall', user_id: 12345 })
    expect(friend?.group_id).toBeUndefined()
  })

  it('maps members joining and leaving', () => {
    const joined = toOneBotEvent(session({
      type: 'guild-member-added',
      userId: '12345',
      guildId: '67890',
      event: { user: { id: '12345' } },
    }))
    expect(joined).toMatchObject({ post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', group_id: 67890 })

    // NTQQ does not say who removed a member, so a removal without an operator is a leave
    const left = toOneBotEvent(session({
      type: 'guild-member-removed',
      userId: '12345',
      guildId: '67890',
      event: { user: { id: '12345' } },
    }))
    expect(left).toMatchObject({ notice_type: 'group_decrease', sub_type: 'leave' })

    const kicked = toOneBotEvent(session({
      type: 'guild-member-removed',
      userId: '12345',
      guildId: '67890',
      event: { user: { id: '12345' }, operator: { id: '999' } },
    }))
    expect(kicked).toMatchObject({ notice_type: 'group_decrease', sub_type: 'kick', operator_id: 999 })
  })

  it('carries the flag a request has to be answered with', () => {
    const friend = toOneBotEvent(session({
      type: 'friend-request',
      userId: '12345',
      messageId: 'friend-uid',
      event: { user: { id: '12345' }, message: { content: '加个好友' } },
    }))
    expect(friend).toMatchObject({
      post_type: 'request',
      request_type: 'friend',
      user_id: 12345,
      comment: '加个好友',
      flag: 'friend-uid',
    })

    const group = toOneBotEvent(session({
      type: 'guild-member-request',
      userId: '12345',
      guildId: '67890',
      messageId: 'flag-1',
      event: { user: { id: '12345' }, message: { content: '求进群' } },
    }))
    expect(group).toMatchObject({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'add',
      group_id: 67890,
      flag: 'flag-1',
    })
  })

  it('skips events with no OneBot 11 counterpart', () => {
    expect(toOneBotEvent(session({ type: 'reaction-added', userId: '12345' }))).toBeUndefined()
  })
})

describe('segments', () => {
  it('keeps the native type names a Java plugin reads', () => {
    const segments = toSegments([
      text('看这个'),
      element('at', { id: '12345' }),
      element('image', { src: 'https://example.com/a.png' }),
      element('face', { id: '13' }),
      element('quote', { id: '42' }),
    ])
    expect(segments).toEqual([
      { type: 'text', data: { text: '看这个' } },
      { type: 'at', data: { qq: '12345' } },
      { type: 'image', data: { file: 'https://example.com/a.png', url: 'https://example.com/a.png' } },
      { type: 'face', data: { id: '13' } },
      { type: 'reply', data: { id: '42' } },
    ])
  })

  it('turns @全体成员 into the all qq', () => {
    expect(toSegments([element('at', { type: 'all' })])).toEqual([{ type: 'at', data: { qq: 'all' } }])
  })

  it('reads the text of elements it has no mapping for', () => {
    const segments = toSegments([element('card', { summary: '一张卡片' })])
    expect(segments).toEqual([{ type: 'text', data: { text: '一张卡片' } }])
  })

  it('escapes the CQ code special characters in text', () => {
    expect(toCQCode([{ type: 'text', data: { text: '&[a],b' } }])).toBe('&amp;&#91;a&#93;&#44;b')
  })

  it('builds CQ codes with parameters, dropping empty ones', () => {
    expect(toCQCode([
      { type: 'at', data: { qq: '12345' } },
      { type: 'image', data: { file: 'https://example.com/a.png', url: '' } },
    ])).toBe('[CQ:at,qq=12345][CQ:image,file=https://example.com/a.png]')
  })
})

describe('toInternalMethod', () => {
  it('camelCases the OneBot action names bot.internal uses', () => {
    expect(toInternalMethod('send_msg')).toBe('sendMsg')
    expect(toInternalMethod('set_group_card')).toBe('setGroupCard')
    expect(toInternalMethod('_send_group_notice')).toBe('sendGroupNotice')
    expect(toInternalMethod('get_group_member_list')).toBe('getGroupMemberList')
  })
})
