/**
 * Ranks tools against a query, for the gateway's `search_tools`.
 *
 * Deliberately lexical: BM25 over the tool name, its description and the
 * server's name, with the name weighted highest. It needs no model, runs in
 * microseconds over a few thousand tools, and its failures are legible — a
 * miss means the words did not appear, which the model can fix by rephrasing.
 */

export interface SearchableTool {
  server: string
  name: string
  description?: string
}

export interface Ranked<T> {
  tool: T
  score: number
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'my', 'me', 'i'])

/** `createPullRequest`, `create_pull-request` and "Create pull requests" all meet at `create pull request`. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem)
}

/** Just enough stemming that plurals and -ing forms match: issues/issue, listing/list. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3)
  if (token.length > 3 && token.endsWith('es') && /(s|x|ch|sh)es$/.test(token)) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

const FIELDS = [
  { weight: 3, text: (t: SearchableTool) => t.name },
  { weight: 2, text: (t: SearchableTool) => t.server },
  { weight: 1, text: (t: SearchableTool) => t.description ?? '' }
]

const K1 = 1.2
const B = 0.75

export function rankTools<T extends SearchableTool>(tools: readonly T[], query: string, limit: number): Array<Ranked<T>> {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0 || tools.length === 0) return []

  // One bag of weighted term counts per tool.
  const docs = tools.map((tool) => {
    const counts = new Map<string, number>()
    let length = 0
    for (const field of FIELDS) {
      for (const token of tokenize(field.text(tool))) {
        counts.set(token, (counts.get(token) ?? 0) + field.weight)
        length += field.weight
      }
    }
    return { tool, counts, length }
  })
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1

  const idf = new Map<string, number>()
  for (const term of terms) {
    const df = docs.filter((d) => d.counts.has(term)).length
    idf.set(term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)))
  }

  const ranked: Array<Ranked<T>> = []
  for (const doc of docs) {
    let score = 0
    for (const term of terms) {
      const tf = doc.counts.get(term)
      if (!tf) continue
      score += (idf.get(term) ?? 0) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLength)))
    }
    if (score > 0) ranked.push({ tool: doc.tool, score })
  }
  ranked.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
  return ranked.slice(0, limit)
}
