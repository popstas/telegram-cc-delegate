import { guestLabel, type Route } from './routes.ts'

export const LANGUAGES = ['en', 'ru'] as const
export type Language = (typeof LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'en'

export function isLanguage(v: unknown): v is Language {
  return typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v)
}

/** Texts people see in Telegram: the guest and the admin. Language comes from config.language. */
export interface Texts {
  noSession: string
  pending: string
  lost: string
  stopped: string
  notAuthorized: string
  stale: string
  allowed: string
  denied: string
  more: string
  confirm: (tool: string, description: string) => string
  chosen: (option: string) => string
  admin: {
    /** Short, without name and id: they are in the log line `admin lost <id>`. */
    lost: (r: Route) => string
    idle: (r: Route, idleHours: number) => string
    moved: (from: Route, to: Route) => string
  }
}

const P = 'telegram-delegate: '

const en: Texts = {
  noSession: 'There is no active session for you right now.',
  pending: 'The session is starting, please write again in a minute.',
  lost: 'Session ended',
  stopped: 'Session closed.',
  notAuthorized: 'Not authorized.',
  stale: 'This request has expired.',
  allowed: 'Allowed',
  denied: 'Denied',
  more: 'Details',
  confirm: (tool, description) => `Confirm: ${tool} - ${description}`,
  chosen: option => `Chosen: ${option}`,
  admin: {
    lost: () => 'Session ended',
    idle: (r, h) => `${P}guest ${guestLabel(r)} has been silent for ${h} h, session ${r.sessionName} is still open.`,
    moved: (from, to) => `${P}route ${guestLabel(to)} moved from ${from.sessionName} to ${to.sessionName}.`,
  },
}

const ru: Texts = {
  noSession: 'Для вас сейчас нет активной сессии.',
  pending: 'Сессия запускается, напишите через минуту.',
  lost: 'Сессия завершена',
  stopped: 'Сессия завершена.',
  notAuthorized: 'Нет доступа.',
  stale: 'Запрос устарел.',
  allowed: 'Разрешено',
  denied: 'Отклонено',
  more: 'Подробнее',
  confirm: (tool, description) => `Подтвердить: ${tool} - ${description}`,
  chosen: option => `Выбрано: ${option}`,
  admin: {
    lost: () => 'Сессия завершена',
    idle: (r, h) => `${P}гость ${guestLabel(r)} молчит ${h} ч, сессия ${r.sessionName} открыта.`,
    moved: (from, to) => `${P}маршрут ${guestLabel(to)} перенесён из ${from.sessionName} в ${to.sessionName}.`,
  },
}

export const TEXTS: Record<Language, Texts> = { en, ru }

/** Texts only the agent reads (channel content, API errors): one language is enough. */
export const AGENT = {
  notWrittenYet: 'the guest has not written to the bot yet',
  movedToSession: 'The guest moved to another session and will not write here anymore.',
  stopToSession: 'The guest ended the session with /stop.',
  unsupported: '[message without text, this type is not supported]',
} as const
