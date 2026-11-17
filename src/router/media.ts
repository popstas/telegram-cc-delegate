import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { MediaHandler } from './telegram.ts'
import type { IncomingMessage } from './types.ts'

/** Telegram Bot API serves files to bots up to 20 MB. */
const MAX_DOWNLOAD = 20 * 1024 * 1024
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen'
const DEFAULT_MODEL = 'nova-3'

export const MT = {
  tooBig: '[файл больше 20 МБ, попросите прислать ссылкой]',
  voice: (text: string) => `[голосовое, расшифровка] ${text}`,
  voiceFailed: '[голосовое, расшифровать не удалось]',
}

/** Uploader-controlled names go into <channel> meta: strip tag/meta delimiters. */
export function safeName(s: string): string {
  return s.replace(/[<>\[\]\r\n;]/g, '_')
}

/** Name for the file on disk. */
function diskName(s: string): string {
  const b = basename(s).replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '_')
  return b.slice(-120) || 'file'
}

type Item = { kind: 'file' | 'audio'; fileId: string; size?: number; name?: string; mime?: string }

function pick(msg: IncomingMessage): Item | undefined {
  if (msg.photo?.length) {
    const best = [...msg.photo].sort((a, b) => (b.file_size ?? b.width * b.height) - (a.file_size ?? a.width * a.height))[0]!
    return { kind: 'file', fileId: best.file_id, size: best.file_size, mime: 'image/jpeg', name: 'photo.jpg' }
  }
  if (msg.document) return { kind: 'file', fileId: msg.document.file_id, size: msg.document.file_size, name: msg.document.file_name, mime: msg.document.mime_type }
  if (msg.voice) return { kind: 'audio', fileId: msg.voice.file_id, size: msg.voice.file_size, mime: msg.voice.mime_type ?? 'audio/ogg', name: 'voice.ogg' }
  if (msg.audio) return { kind: 'audio', fileId: msg.audio.file_id, size: msg.audio.file_size, name: msg.audio.file_name, mime: msg.audio.mime_type }
  if (msg.video_note) return { kind: 'audio', fileId: msg.video_note.file_id, size: msg.video_note.file_size, mime: 'video/mp4', name: 'video_note.mp4' }
  return undefined
}

export function createMedia(deps: {
  download: (fileId: string) => Promise<{ data: Buffer; name: string; mime?: string }>
  inboxDir: (sessionId: string) => string
  deepgram?: { key: string; language: string; model?: string }
  fetch?: typeof fetch
  /** Deepgram request timeout, default 60 s. */
  timeoutMs?: number
}): MediaHandler {
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? 60_000

  async function transcribe(data: Buffer, mime: string): Promise<string> {
    const dg = deps.deepgram
    if (!dg?.key) throw new Error('DEEPGRAM_API_KEY не задан')
    const q = new URLSearchParams({ model: dg.model || DEFAULT_MODEL, language: dg.language, smart_format: 'true', punctuate: 'true' })
    const res = await doFetch(`${DEEPGRAM_URL}?${q}`, {
      method: 'POST',
      headers: { authorization: `Token ${dg.key}`, 'content-type': mime },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`deepgram HTTP ${res.status} ${body}`.trim())
    }
    const json = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } }
    const text = json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim()
    if (!text) throw new Error('пустая расшифровка')
    return text
  }

  return {
    async toEvent(msg, sessionId) {
      const item = pick(msg)
      if (!item) return undefined
      const caption = msg.caption ?? ''
      const meta: Record<string, string> = {}
      if (item.name) meta.file_name = safeName(item.name)
      if (item.size != null && item.size > MAX_DOWNLOAD) return { content: MT.tooBig, meta }

      const file = await deps.download(item.fileId)
      const name = item.name ?? file.name
      const mime = item.mime ?? file.mime
      const dir = deps.inboxDir(sessionId)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${Date.now()}-${diskName(name)}`)
      writeFileSync(path, file.data, { mode: 0o600 })
      meta.file_name = safeName(name)
      if (mime) meta.file_mime = mime

      if (item.kind === 'file') {
        meta.file_path = path
        return { content: caption, meta }
      }
      meta.audio_path = path
      try {
        const text = await transcribe(file.data, mime ?? 'application/octet-stream')
        return { content: MT.voice(text), meta }
      } catch (e) {
        meta.stt_error = (e instanceof Error ? e.message : String(e)).replace(/[\r\n]/g, ' ')
        return { content: MT.voiceFailed, meta }
      }
    },
  }
}
