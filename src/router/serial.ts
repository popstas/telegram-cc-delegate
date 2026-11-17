/**
 * Runs tasks one after another per key, keys in parallel. grammy handles updates one at a time,
 * so a slow voice download for one guest would otherwise stall every guest and every button.
 */
export function createSerial(onError: (e: unknown) => void = () => {}) {
  const tails = new Map<string, Promise<void>>()
  return (key: string, fn: () => Promise<void>): Promise<void> => {
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn).catch(onError)
    tails.set(key, next)
    void next.finally(() => {
      if (tails.get(key) === next) tails.delete(key)
    })
    return next
  }
}
