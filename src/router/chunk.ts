/** Splits text into parts of at most `limit` chars, preferring the last newline inside the window. */
export function chunk(text: string, limit = 4096): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > limit) {
    const nl = rest.lastIndexOf('\n', limit)
    if (nl > 0) {
      parts.push(rest.slice(0, nl))
      rest = rest.slice(nl + 1)
    } else {
      parts.push(rest.slice(0, limit))
      rest = rest.slice(limit)
    }
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest)
  return parts
}
