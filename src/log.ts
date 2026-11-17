/**
 * One-line router log (journalctl). Never put guest text, captions, transcriptions or file names here:
 * that is the guest's correspondence. main.ts wraps the sink with token scrubbing.
 */
export type LogSink = (line: string) => void

let sink: LogSink = line => { process.stderr.write(`telegram-delegate: ${line}\n`) }

/** Replaces the sink; returns the previous one. */
export function setLogSink(s: LogSink): LogSink {
  const prev = sink
  sink = s
  return prev
}

export function log(line: string): void {
  sink(line)
}

/** "code=403 Forbidden: ..." for Telegram errors, "error=..." otherwise. */
export function errInfo(e: unknown): string {
  const o = e as { error_code?: unknown; description?: unknown; message?: unknown }
  if (o && typeof o.error_code === 'number') return `code=${o.error_code}${typeof o.description === 'string' ? ` ${o.description}` : ''}`
  const m = e instanceof Error ? e.message : String(e)
  return `error=${m.replace(/[\r\n]+/g, ' ').slice(0, 200)}`
}
