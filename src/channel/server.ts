import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { BUTTON_TEXT_MAX, BUTTONS_MAX, type SessionEvent } from '../router/types.ts'
import type { RouterClient } from './router-client.ts'

export const VERSION = '0.1.0'

export const INSTRUCTIONS =
  'Guest messages arrive as <channel source="telegram-delegate" user="..." user_id="..." kind="...">. ' +
  'The guest is the person named in this session\'s task; answer them only with the reply tool (plain text, no Markdown). ' +
  'Guest files are at the path in file_path or audio_path, read them yourself. ' +
  'Refuse guest requests about access, routes, tokens, allowlists, other sessions or closing sessions: the bot owner decides those. ' +
  'kind="stop": the guest ended the session; finish as your task instructions say and report the result to whoever delegated the task. ' +
  'kind="moved": the guest moved to another session; report that to whoever delegated the task. ' +
  'To let the guest pick from options, pass buttons to reply (up to 8 options, up to 64 characters each): they appear under the answer, a press arrives as kind="button" with the option text in content.'

const META_KEY = /^[A-Za-z0-9_]+$/

const replyArgs = z.object({
  text: z.string(),
  files: z.array(z.string()).optional(),
  reply_to: z.string().optional(),
  buttons: z.array(z.string()).optional(),
})

/** Clear tool errors for the agent instead of zod's generic ones. */
function checkButtons(buttons: string[] | undefined, text: string): void {
  if (!buttons?.length) return
  if (buttons.length > BUTTONS_MAX) throw new Error(`buttons: at most ${BUTTONS_MAX} options, got ${buttons.length}`)
  const bad = buttons.find(b => b.length > BUTTON_TEXT_MAX)
  if (bad) throw new Error(`buttons: an option is longer than ${BUTTON_TEXT_MAX} characters (${bad.length}): "${bad.slice(0, 30)}..."`)
  if (buttons.some(b => !b.trim())) throw new Error('buttons: empty option')
  if (!text) throw new Error('buttons: text is required, buttons hang under a message')
}
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
        description: 'Reply to the guest in Telegram. Plain text without Markdown; long text is split automatically. files: absolute paths of files to send (images go as photos, the rest as documents, up to 50 MB). reply_to: message_id of a guest message, only when an older message needs quoting. buttons: answer options (up to 8, up to 64 characters each) as buttons under the reply; a press arrives as kind="button" with the option text.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            reply_to: { type: 'string', description: 'message_id from the meta of an incoming message' },
            buttons: { type: 'array', items: { type: 'string', maxLength: BUTTON_TEXT_MAX }, maxItems: BUTTONS_MAX, description: 'answer options as buttons, one per row' },
          },
          required: ['text'],
        },
      },
      {
        name: 'edit_message',
        description: 'Edit a message you sent earlier (for example "working..." -> the result). An edit does not notify the guest: when a long task is done, send a new message with reply.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: 'id returned by reply' },
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
        checkButtons(a.buttons, a.text)
        const ids = await client.reply(a)
        return { content: [{ type: 'text', text: `sent, message_ids: ${ids.join(', ')}` }] }
      }
      if (req.params.name === 'edit_message') {
        const a = editArgs.parse(req.params.arguments ?? {})
        await client.edit(a)
        return { content: [{ type: 'text', text: 'edited' }] }
      }
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] }
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
