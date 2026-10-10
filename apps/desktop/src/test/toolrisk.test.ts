import { describe, expect, it } from 'vitest'
import { classifyTool, estimateToolTokens, summarizeInventory } from '@shared/toolrisk'

describe('tool classification', () => {
  it('recognises the four capability classes from the name', () => {
    expect(classifyTool('run_shell_command').capability).toBe('execute')
    expect(classifyTool('delete_card').capability).toBe('destructive')
    expect(classifyTool('create_board').capability).toBe('write')
    expect(classifyTool('list_boards').capability).toBe('read')
  })

  it('ranks the most dangerous class first when a name matches several', () => {
    // "execute" is checked before "read", so this is not misread as read-only.
    expect(classifyTool('get_shell_output').capability).toBe('execute')
    expect(classifyTool('list_and_delete').capability).toBe('destructive')
  })

  it('prefers the name over the description', () => {
    // A read tool whose description happens to mention creation stays read.
    expect(classifyTool('list_cards', 'List the cards you create on a board').capability).toBe('read')
  })

  it('falls back to the description only when the name is uninformative', () => {
    expect(classifyTool('trello', 'Delete a card permanently').capability).toBe('destructive')
    expect(classifyTool('xyzzy').capability).toBe('unknown')
  })

  it('estimates the context cost of a definition', () => {
    const tokens = estimateToolTokens({ name: 'get_board', description: 'Get a board by id', schema: { type: 'object' } })
    expect(tokens).toBeGreaterThan(0)
    expect(estimateToolTokens({ name: 'x' })).toBeLessThan(tokens)
  })

  it('summarises an inventory', () => {
    const summary = summarizeInventory([
      { name: 'list_boards', description: 'List boards' },
      { name: 'create_card', description: 'Create a card' },
      { name: 'delete_card', description: 'Delete a card' },
      { name: 'run_script', description: 'Run a script' }
    ])
    expect(summary.total).toBe(4)
    expect(summary.byCapability.read).toBe(1)
    expect(summary.byCapability.destructive).toBe(1)
    expect(summary.riskyCount).toBe(3)
    expect(summary.tokens).toBeGreaterThan(0)
  })
})
