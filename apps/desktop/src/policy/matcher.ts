/** Glob and JSON-path helpers used by the policy matcher. */

const GLOB_CACHE = new Map<string, RegExp>()

/** Compiles a `*`/`?` glob to an anchored, case-insensitive regex. */
export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_CACHE.get(glob)
  if (cached) return cached
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  const re = new RegExp(`^${escaped}$`, 'i')
  GLOB_CACHE.set(glob, re)
  return re
}

/**
 * Matches a pattern against a value. A pattern is a `*`/`?` glob unless it
 * starts with `re:`, in which case the remainder is a case-insensitive regex.
 */
export function globMatch(pattern: string | undefined, value: string | null): boolean {
  if (pattern === undefined || pattern === '*' || pattern === '') return true
  if (value === null) return false
  if (pattern.startsWith('re:')) {
    const re = safeRegExp(pattern.slice(3))
    return re ? re.test(value) : false
  }
  return globToRegExp(pattern).test(value)
}

/** Reads `a.b.0.c` out of a parsed JSON value. Returns undefined when absent. */
export function readPath(value: unknown, path: string): unknown {
  if (!path) return value
  let cur: any = value
  for (const segment of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[segment]
  }
  return cur
}

/** Compiles user-supplied regex safely; an invalid pattern never matches. */
export function safeRegExp(pattern: string, flags = 'i'): RegExp | null {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

export function stringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}
