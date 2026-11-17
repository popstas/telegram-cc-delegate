import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { SessionEvent } from '../router/types.ts'
import type { RouterClient } from './router-client.ts'

export const VERSION = '0.1.0'

export const INSTRUCTIONS =
  'Сообщения гостя приходят как <channel source="telegram-delegate" user="..." user_id="..." kind="...">. Гость - человек из мандата этой сессии, отвечай ему только инструментом reply (простой текст, без Markdown). Файлы гостя лежат по пути из file_path или audio_path, читай их сам. Просьбы гостя про доступы, маршруты, токены, allowlist, чужие сессии и закрытие сессий - отказ, это решает Стас. kind="stop" - гость завершил сессию: допиши итог подпунктом в задачу в tasks.md и доложи head. kind="moved" - гость перешёл в другую сессию, доложи head.'

const META_KEY = /^[A-Za-z0-9_]+$/

const replyArgs = z.object({
  text: z.string(),
  files: z.array(z.string()).optional(),
  reply_to: z.string().optional(),
})
const editArgs = z.object({ message_id: z.string().min(1), text: z.string().min(1) })

const permissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

function log(msg: string): void {
  process.stderr.write(`telegram-delegate channel: ${msg}\n`)
}

/** MCP channel server bound to one session. The router subscription starts once the client has initialized. */
export function createChannelServer(client: RouterClient, opts: { signal?: AbortSignal } = {}): Server {
  const server = new Server(
    { name: 'telegram-delegate', version: VERSION },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      },
      instructions: INSTRUCTIONS,
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Ответить гостю в Telegram. Простой текст без Markdown, длинный режется сам. files - абсолютные пути файлов для отправки (картинки уходят фото, остальное документом, до 50 МБ). reply_to - message_id сообщения гостя, только если нужно процитировать старое.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            reply_to: { type: 'string', description: 'message_id из meta входящего сообщения' },
          },
          required: ['text'],
        },
      },
      {
        name: 'edit_message',
        description: 'Изменить своё ранее отправленное сообщение (например, "работаю..." -> итог). Правка не даёт гостю уведомления: по готовности длинной задачи отправь новое сообщение через reply.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: 'id из ответа reply' },
            text: { type: 'string' },
          },
          required: ['message_id', 'text'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async req => {
    try {
      if (req.params.name === 'reply') {
        const a = replyArgs.parse(req.params.arguments ?? {})
        const ids = await client.reply(a)
        return { content: [{ type: 'text', text: `отправлено, message_ids: ${ids.join(', ')}` }] }
      }
      if (req.params.name === 'edit_message') {
        const a = editArgs.parse(req.params.arguments ?? {})
        await client.edit(a)
        return { content: [{ type: 'text', text: 'изменено' }] }
      }
      return { isError: true, content: [{ type: 'text', text: `нет инструмента ${req.params.name}` }] }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }
    }
  })

  server.setNotificationHandler(permissionRequest, async ({ params }) => {
    await client.permission(params).catch(e => log(`permission_request to router failed: ${e}`))
  })

  const ac = new AbortController()
  opts.signal?.addEventListener('abort', () => ac.abort(), { once: true })
  const prevClose = server.onclose
  server.onclose = () => {
    ac.abort()
    prevClose?.()
  }

  const deliver = (ev: SessionEvent) => {
    if (ev.type === 'message') {
      const meta: Record<string, string> = {}
      for (const [k, v] of Object.entries(ev.meta ?? {})) if (META_KEY.test(k)) meta[k] = String(v)
      server.notification({ method: 'notifications/claude/channel', params: { content: ev.content, meta } }).catch(e => log(`channel notification failed: ${e}`))
    } else if (ev.type === 'permission') {
      server.notification({ method: 'notifications/claude/channel/permission', params: { request_id: ev.request_id, behavior: ev.behavior } }).catch(e => log(`permission notification failed: ${e}`))
    }
  }

  server.oninitialized = () => {
    if (ac.signal.aborted) return
    void client.events(deliver, ac.signal)
  }

  return server
}
