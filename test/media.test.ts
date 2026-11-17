import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMedia } from '../src/router/media.ts'
import type { IncomingMessage } from '../src/router/types.ts'

const base: IncomingMessage = { message_id: 7, date: 1_700_000_000, chat: { id: 42, type: 'private' }, from: { id: 42 } }

function setup(opts: { key?: string; fetchImpl?: typeof fetch } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'td-media-'))
  const downloads: string[] = []
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
  const media = createMedia({
    download: async fileId => {
      downloads.push(fileId)
      return { data: Buffer.from(`data-${fileId}`), name: `file_${fileId}.bin`, mime: 'application/octet-stream' }
    },
    inboxDir: id => join(root, 'inbox', id),
    deepgram: opts.key ? { key: opts.key, language: 'ru' } : undefined,
    fetch: (opts.fetchImpl
      ? (async (url: string, init?: RequestInit) => { fetchCalls.push({ url, init }); return opts.fetchImpl!(url, init) })
      : (async (url: string, init?: RequestInit) => { fetchCalls.push({ url, init }); throw new Error('no fetch expected') })) as typeof fetch,
  })
  return { media, root, downloads, fetchCalls }
}

const dgOk = (transcript: string) => (async () =>
  new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }), { status: 200 })) as unknown as typeof fetch

describe('media', () => {
  it('text message gives undefined', async () => {
    const { media } = setup()
    expect(await media.toEvent({ ...base, text: 'hi' }, 's1')).toBeUndefined()
  })

  it('photo saved to inbox', async () => {
    const { media, root, downloads } = setup()
    const ev = await media.toEvent({
      ...base,
      caption: 'смотри',
      photo: [
        { file_id: 'small', width: 90, height: 90, file_size: 1000 },
        { file_id: 'big', width: 1280, height: 1280, file_size: 90000 },
      ],
    }, 's1')
    expect(downloads).toEqual(['big'])
    expect(ev?.content).toBe('смотри')
    const p = ev!.meta.file_path!
    expect(p.startsWith(join(root, 'inbox', 's1') + '/')).toBe(true)
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('data-big')
    expect(ev!.meta.file_name).toBeTruthy()
  })

  it('document keeps original name and mime, sanitized', async () => {
    const { media } = setup()
    const ev = await media.toEvent({ ...base, document: { file_id: 'd1', file_name: 'отчёт <v2>.pdf', mime_type: 'application/pdf', file_size: 10 } }, 's1')
    expect(ev?.content).toBe('')
    expect(ev?.meta.file_mime).toBe('application/pdf')
    expect(ev?.meta.file_name).toBe('отчёт _v2_.pdf')
    expect(ev?.meta.file_path).toMatch(/-отчёт__v2_\.pdf$/)
  })

  it('voice transcribed', async () => {
    const { media, fetchCalls } = setup({ key: 'dg-key', fetchImpl: dgOk('привет') })
    const ev = await media.toEvent({ ...base, voice: { file_id: 'v1', mime_type: 'audio/ogg', file_size: 5000, duration: 2 } }, 's1')
    expect(ev?.content).toBe('[голосовое, расшифровка] привет')
    expect(existsSync(ev!.meta.audio_path!)).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    const { url, init } = fetchCalls[0]!
    expect(url.startsWith('https://api.deepgram.com/v1/listen?')).toBe(true)
    const q = new URL(url).searchParams
    expect(q.get('language')).toBe('ru')
    expect(q.get('model')).toBe('nova-3')
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Token dg-key')
    expect(headers.get('content-type')).toBe('audio/ogg')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('voice without key', async () => {
    const { media, fetchCalls } = setup()
    const ev = await media.toEvent({ ...base, voice: { file_id: 'v1', file_size: 5000 } }, 's1')
    expect(ev?.content).toBe('[голосовое, расшифровать не удалось]')
    expect(ev?.meta.stt_error).toBeTruthy()
    expect(existsSync(ev!.meta.audio_path!)).toBe(true)
    expect(fetchCalls).toHaveLength(0)
  })

  it('deepgram error keeps audio path', async () => {
    const fail = (async () => new Response('{"err_msg":"bad"}', { status: 401 })) as unknown as typeof fetch
    const { media } = setup({ key: 'dg-key', fetchImpl: fail })
    const ev = await media.toEvent({ ...base, audio: { file_id: 'a1', file_name: 'rec.mp3', mime_type: 'audio/mpeg', file_size: 5000 } }, 's1')
    expect(ev?.content).toBe('[голосовое, расшифровать не удалось]')
    expect(ev?.meta.stt_error).toContain('401')
    expect(existsSync(ev!.meta.audio_path!)).toBe(true)
  })

  it('video note goes to stt too', async () => {
    const { media } = setup({ key: 'dg-key', fetchImpl: dgOk('кружок') })
    const ev = await media.toEvent({ ...base, video_note: { file_id: 'vn1', file_size: 5000 } }, 's1')
    expect(ev?.content).toBe('[голосовое, расшифровка] кружок')
    expect(ev?.meta.audio_path).toBeTruthy()
  })

  it('file over 20mb not downloaded', async () => {
    const { media, downloads } = setup()
    const ev = await media.toEvent({ ...base, document: { file_id: 'huge', file_name: 'big.zip', file_size: 21 * 1024 * 1024 } }, 's1')
    expect(ev?.content).toBe('[файл больше 20 МБ, попросите прислать ссылкой]')
    expect(downloads).toEqual([])
    expect(ev?.meta.file_path).toBeUndefined()
  })
})
