import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTelegram, type BotLike, type MediaHandler } from '../src/router/telegram.ts'
import type { IncomingMessage, SessionEvent } from '../src/router/types.ts'
import { RouteStore } from '../src/routes.ts'

type Call = { fn: string; args: unknown[] }

function fakeBot(): BotLike & { calls: Call[] } {
  const calls: Call[] = []
  let id = 500
  return {
    calls,
    api: {
      async sendMessage(...args) { calls.push({ fn: 'sendMessage', args }); return { message_id: ++id } },
      async editMessageText(...args) { calls.push({ fn: 'editMessageText', args }); return true },
      async sendDocument(...args) { calls.push({ fn: 'sendDocument', args }); return { message_id: ++id } },
      async sendPhoto(...args) { calls.push({ fn: 'sendPhoto', args }); return { message_id: ++id } },
      async sendChatAction(...args) { calls.push({ fn: 'sendChatAction', args }); return true },
      async getMe() { return { username: 'td_test_bot' } },
    },
  }
}

function fakeHub(connected = true) {
  const sent: Array<{ sessionId: string; ev: SessionEvent }> = []
  return {
    sent,
    connected: (_id: string) => connected,
    send(sessionId: string, ev: SessionEvent) {
      if (!connected) return false
      sent.push({ sessionId, ev })
      return true
    },
  }
}

const noMedia: MediaHandler = { toEvent: async () => undefined }

function setup(opts: { hubConnected?: boolean; media?: MediaHandler; status?: 'pending' | 'active' | 'lost' | 'closed' } = {}) {
  const store = new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-tg-')), 'routes.json'))
  store.upsert({ sessionId: 's1', sessionName: 'guest-task', headId: 'head', tgUsername: 'alexiapost' }, 0)
  store.setStatus('s1', opts.status ?? 'active')
  const bot = fakeBot()
  const hub = fakeHub(opts.hubConnected ?? true)
  const tg = createTelegram({ bot, store, hub, media: opts.media ?? noMedia, adminUserId: '241225329', now: () => 5000 })
  return { store, bot, hub, tg }
}

function msg(text: string, o: { id?: number; username?: string; chatType?: string } = {}): IncomingMessage {
  const id = o.id ?? 42
  return {
    message_id: 7,
    date: 1_700_000_000,
    chat: { id: o.chatType && o.chatType !== 'private' ? -100 : id, type: o.chatType ?? 'private' },
    from: { id, username: o.username ?? 'alexiapost', first_name: 'Alexia' },
    text,
  }
}

const sentTexts = (bot: ReturnType<typeof fakeBot>) => bot.calls.filter(c => c.fn === 'sendMessage').map(c => [c.args[0], c.args[1]])
const req = { request_id: 'abcde', tool_name: 'Bash', description: 'run ls', input_preview: '{"command":"ls"}' }

describe('telegram side', () => {
  it('group message ignored', async () => {
    const { tg, bot, hub } = setup()
    await tg.onMessage(msg('hi', { chatType: 'group' }))
    await tg.onMessage(msg('hi', { chatType: 'supergroup', id: 999, username: 'stranger' }))
    expect(bot.calls).toEqual([])
    expect(hub.sent).toEqual([])
  })

  it('stranger gets no-session text', async () => {
    const { tg, bot, hub } = setup()
    await tg.onMessage(msg('hi', { id: 999, username: 'stranger' }))
    expect(sentTexts(bot)).toEqual([['999', 'Для вас сейчас нет активной сессии.']])
    expect(hub.sent).toEqual([])
  })

  it('pending and lost texts', async () => {
    const p = setup({ status: 'pending' })
    await p.tg.onMessage(msg('hi'))
    expect(sentTexts(p.bot)).toEqual([['42', 'Сессия запускается, напишите через минуту.']])
    const l = setup({ status: 'lost' })
    await l.tg.onMessage(msg('hi'))
    expect(sentTexts(l.bot)).toEqual([['42', 'Сессия прервалась, Стас в курсе.']])
    expect(p.hub.sent).toEqual([])
    expect(l.hub.sent).toEqual([])
  })

  it('closed route gets no-session text', async () => {
    const { tg, bot } = setup({ status: 'closed' })
    await tg.onMessage(msg('hi'))
    expect(sentTexts(bot)).toEqual([['42', 'Для вас сейчас нет активной сессии.']])
  })

  it('guest message reaches session with meta', async () => {
    const { tg, bot, hub, store } = setup()
    await tg.onMessage(msg('привет'))
    expect(hub.sent).toHaveLength(1)
    const { sessionId, ev } = hub.sent[0]!
    expect(sessionId).toBe('s1')
    expect(ev.type).toBe('message')
    if (ev.type !== 'message') return
    expect(ev.content).toBe('привет')
    expect(ev.meta).toEqual({ chat_id: '42', message_id: '7', user: 'alexiapost', user_id: '42', ts: new Date(1_700_000_000_000).toISOString(), kind: 'guest' })
    expect(store.get('s1')?.lastMessageAt).toBe(5000)
    expect(bot.calls.some(c => c.fn === 'sendChatAction' && c.args[0] === '42')).toBe(true)
    expect(sentTexts(bot)).toEqual([])
  })

  it('media fields are merged into meta', async () => {
    const media: MediaHandler = { toEvent: async () => ({ content: '[голосовое, расшифровка] привет', meta: { audio_path: '/x/a.ogg' } }) }
    const { tg, hub } = setup({ media })
    await tg.onMessage({ ...msg(''), text: undefined, voice: { file_id: 'v1' } })
    const ev = hub.sent[0]!.ev
    if (ev.type !== 'message') throw new Error('not a message')
    expect(ev.content).toBe('[голосовое, расшифровка] привет')
    expect(ev.meta.audio_path).toBe('/x/a.ogg')
    expect(ev.meta.kind).toBe('guest')
  })

  it('disconnected session answers lost', async () => {
    const { tg, bot } = setup({ hubConnected: false })
    await tg.onMessage(msg('hi'))
    expect(sentTexts(bot)).toEqual([['42', 'Сессия прервалась, Стас в курсе.']])
  })

  it('stop closes route and notifies session', async () => {
    const { tg, bot, hub, store } = setup()
    await tg.onMessage(msg('/stop'))
    expect(store.get('s1')?.status).toBe('closed')
    expect(sentTexts(bot)).toEqual([['42', 'Сессия завершена.']])
    expect(hub.sent).toEqual([{ sessionId: 's1', ev: { type: 'message', content: 'Гость завершил сессию командой /stop.', meta: { kind: 'stop' } } }])
  })

  it('askPermission sends buttons', async () => {
    const { tg, bot } = setup()
    await tg.askPermission('42', 's1', req)
    const call = bot.calls.find(c => c.fn === 'sendMessage')!
    expect(call.args[0]).toBe('42')
    expect(call.args[1]).toBe('Подтвердить: Bash - run ls')
    const kb = JSON.stringify(call.args[2])
    for (const d of ['perm:allow:abcde', 'perm:deny:abcde', 'perm:more:abcde']) expect(kb).toContain(d)
  })

  it('yes <id> becomes verdict', async () => {
    const { tg, hub, store } = setup()
    store.matchSender({ id: '42', username: 'alexiapost' })
    await tg.askPermission('42', 's1', req)
    await tg.onMessage(msg('yes abcde'))
    expect(hub.sent).toEqual([{ sessionId: 's1', ev: { type: 'permission', request_id: 'abcde', behavior: 'allow' } }])
    await tg.onMessage(msg('n abcde'))
    // request already answered: plain message now
    expect(hub.sent[1]!.ev.type).toBe('message')
  })

  it('yes <id> without open request is a normal message', async () => {
    const { tg, hub } = setup()
    await tg.onMessage(msg('yes abcde'))
    expect(hub.sent[0]!.ev.type).toBe('message')
  })

  it('button press by guest sends verdict and removes buttons', async () => {
    const { tg, hub, bot } = setup()
    await tg.askPermission('42', 's1', req)
    const answers: Array<string | undefined> = []
    await tg.onCallback({ id: 'q1', from: { id: 42 }, data: 'perm:deny:abcde' }, async t => { answers.push(t) })
    expect(hub.sent).toEqual([{ sessionId: 's1', ev: { type: 'permission', request_id: 'abcde', behavior: 'deny' } }])
    const edit = bot.calls.find(c => c.fn === 'editMessageText')!
    expect(edit.args[0]).toBe('42')
    expect(JSON.stringify(edit.args)).not.toContain('perm:')
    expect(answers).toHaveLength(1)
    await tg.onCallback({ id: 'q2', from: { id: 42 }, data: 'perm:allow:abcde' }, async t => { answers.push(t) })
    expect(answers[1]).toBe('Запрос устарел.')
    expect(hub.sent).toHaveLength(1)
  })

  it('more shows input preview', async () => {
    const { tg, bot, hub } = setup()
    await tg.askPermission('42', 's1', { ...req, input_preview: 'x'.repeat(5000) })
    await tg.onCallback({ id: 'q1', from: { id: 42 }, data: 'perm:more:abcde' }, async () => {})
    const edit = bot.calls.find(c => c.fn === 'editMessageText')!
    const text = String(edit.args[2])
    expect(text).toContain('x'.repeat(3500))
    expect(text).not.toContain('x'.repeat(3501))
    expect(JSON.stringify(edit.args[3])).toContain('perm:allow:abcde')
    expect(hub.sent).toEqual([])
  })

  it('foreign button press rejected', async () => {
    const { tg, hub } = setup()
    await tg.askPermission('42', 's1', req)
    const answers: Array<string | undefined> = []
    await tg.onCallback({ id: 'q1', from: { id: 999 }, data: 'perm:allow:abcde' }, async t => { answers.push(t) })
    expect(answers).toEqual(['Not authorized.'])
    expect(hub.sent).toEqual([])
  })

  it('stale request rejected', async () => {
    const { tg, hub } = setup()
    const answers: Array<string | undefined> = []
    await tg.onCallback({ id: 'q1', from: { id: 42 }, data: 'perm:allow:zzzzz' }, async t => { answers.push(t) })
    expect(answers).toEqual(['Запрос устарел.'])
    expect(hub.sent).toEqual([])
  })

  it('request of a closed route is stale', async () => {
    const { tg, hub, store } = setup()
    await tg.askPermission('42', 's1', req)
    store.setStatus('s1', 'closed')
    const answers: Array<string | undefined> = []
    await tg.onCallback({ id: 'q1', from: { id: 42 }, data: 'perm:allow:abcde' }, async t => { answers.push(t) })
    expect(answers).toEqual(['Запрос устарел.'])
    expect(hub.sent).toEqual([])
  })

  it('notifyAdmin sends to adminUserId', async () => {
    const { tg, bot } = setup()
    await tg.notifyAdmin('telegram-delegate: test')
    expect(sentTexts(bot)).toEqual([['241225329', 'telegram-delegate: test']])
  })

  it('sendText chunks long text without parse_mode', async () => {
    const { tg, bot } = setup()
    const ids = await tg.sendText('42', 'a'.repeat(5000) + ' *x*', '3')
    expect(ids).toHaveLength(2)
    const calls = bot.calls.filter(c => c.fn === 'sendMessage')
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(String(c.args[1]).length).toBeLessThanOrEqual(4096)
      expect(JSON.stringify(c.args[2] ?? {})).not.toContain('parse_mode')
    }
    expect(JSON.stringify(calls[0]!.args[2])).toContain('"message_id":3')
  })

  it('sendFiles picks photo or document and rejects missing or huge files', async () => {
    const { tg, bot } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'td-files-'))
    writeFileSync(join(dir, 'a.png'), 'png')
    writeFileSync(join(dir, 'b.pdf'), 'pdf')
    const ids = await tg.sendFiles('42', [join(dir, 'a.png'), join(dir, 'b.pdf')])
    expect(ids).toHaveLength(2)
    expect(bot.calls.map(c => c.fn)).toEqual(['sendPhoto', 'sendDocument'])
    await expect(tg.sendFiles('42', [join(dir, 'nope.txt')])).rejects.toThrow(/nope\.txt/)
    await expect(tg.sendFiles('42', ['relative.txt'])).rejects.toThrow(/relative\.txt/)
    writeFileSync(join(dir, 'big.bin'), '')
    truncateSync(join(dir, 'big.bin'), 51 * 1024 * 1024)
    await expect(tg.sendFiles('42', [join(dir, 'big.bin')])).rejects.toThrow(/big\.bin/)
    expect(bot.calls).toHaveLength(2)
  })

  it('botUsername after init', async () => {
    const { tg } = setup()
    await tg.init()
    expect(tg.botUsername()).toBe('td_test_bot')
  })
})
