import { guestLabel, type Route } from './routes.ts'

/** Fixed bot texts (plan, Global Constraints). */
export const T = {
  noSession: 'Для вас сейчас нет активной сессии.',
  pending: 'Сессия запускается, напишите через минуту.',
  lost: 'Сессия прервалась, Стас в курсе.',
  stopped: 'Сессия завершена.',
  notAuthorized: 'Not authorized.',
  stale: 'Запрос устарел.',
  notWrittenYet: 'гость ещё не писал боту',
  movedToSession: 'Гость перешёл в другую сессию и сюда больше не пишет.',
  stopToSession: 'Гость завершил сессию командой /stop.',
} as const

const P = 'telegram-delegate: '

/** Admin texts, prefixed except lost. */
export const A = {
  /** Stas 17.11: short, without name and id (they are in the log line `admin lost <id>`). */
  lost: (_r: Route) => 'Сессия завершена',
  idle: (r: Route, idleHours: number) => `${P}гость ${guestLabel(r)} молчит ${idleHours} ч, сессия ${r.sessionName} открыта.`,
  moved: (from: Route, to: Route) => `${P}маршрут ${guestLabel(to)} перенесён из ${from.sessionName} в ${to.sessionName}.`,
}
