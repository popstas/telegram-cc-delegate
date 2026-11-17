export type SessionEvent =
  | { type: 'message'; content: string; meta: Record<string, string> }
  | { type: 'permission'; request_id: string; behavior: 'allow' | 'deny' }

export interface AnswerButtons {
  sessionId: string
  options: string[]
}

/** Answer buttons: up to 8 options, each up to 64 chars. */
export const BUTTONS_MAX = 8
export const BUTTON_TEXT_MAX = 64

export interface PermissionRequest {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

/** Everything the router sends to Telegram. Implemented by createTelegram (task 3). */
export interface Outbound {
  /** buttons: answer options shown under the last chunk; a press comes back to sessionId as kind=button. */
  sendText(userId: string, text: string, replyTo?: string, buttons?: AnswerButtons): Promise<string[]>
  sendFiles(userId: string, files: string[]): Promise<string[]>
  editText(userId: string, messageId: string, text: string): Promise<void>
  askPermission(userId: string, sessionId: string, req: PermissionRequest): Promise<void>
  notifyAdmin(text: string): Promise<void>
  botUsername(): string
}

/** Subset of grammy's Message that the router reads. grammy's Message is assignable to it. */
export interface IncomingMessage {
  message_id: number
  date: number
  chat: { id: number; type: string }
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean }
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; file_unique_id?: string; width: number; height: number; file_size?: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  voice?: { file_id: string; mime_type?: string; file_size?: number; duration?: number }
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number; duration?: number }
  video_note?: { file_id: string; file_size?: number; duration?: number }
}
