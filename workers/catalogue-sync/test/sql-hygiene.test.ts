/**
 * A backtick inside a SQL comment terminates the JavaScript template literal
 * it sits in, and the resulting parse error points at a line nowhere near the
 * cause. It happened three times while writing these queries, so it is now a
 * test rather than a thing to remember.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const DIRS = [
  join(ROOT, 'workers', 'catalogue-sync', 'src'),
  join(ROOT, 'apps', 'api', 'src')
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  )
}

describe('SQL hygiene', () => {
  it('has no backtick inside a SQL line comment', () => {
    const offenders: string[] = []
    for (const dir of DIRS) {
      for (const file of sources(dir)) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (line.trimStart().startsWith('--') && line.includes('`')) {
            offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`)
          }
        })
      }
    }
    expect(offenders, 'a backtick in a SQL comment ends the template literal').toEqual([])
  })
})
