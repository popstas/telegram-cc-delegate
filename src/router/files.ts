import { realpathSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + sep)
}

/**
 * The agent may send its own files and its own guest's inbox, never router secrets/state or
 * another session's inbox (prompt injection could ask for them). Throws with the file name.
 */
export function assertSendable(file: string, sessionId: string, dirs: { stateDir: string; configDir: string }): void {
  const p = real(file)
  const config = real(dirs.configDir)
  const state = real(dirs.stateDir)
  const ownInbox = real(join(dirs.stateDir, 'inbox', sessionId))
  if (within(p, config) || (within(p, state) && !within(p, ownInbox))) {
    throw new Error(`file ${basename(file)} is in the router's internal directory and cannot be sent`)
  }
}
