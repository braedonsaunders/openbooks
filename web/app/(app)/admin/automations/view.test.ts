import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { automationsSpec } = await import('./view')
import type { AutomationsData } from './view'

// UX-20: the automations page repeated its empty state — the empty-state
// card AND the table's own empty copy rendered together. The spec gives the
// single empty card to `isEmpty` and the table to `hasRows` (the loader sets
// exactly one), so an empty page is one card and never a table.
function specFor(isEmpty: boolean, hasRows: boolean) {
  return automationsSpec({
    currentParams: {},
    statusLabel: 'Status',
    statusOptions: [],
    isEmpty,
    hasRows,
  } as unknown as AutomationsData)
}

test('an empty page shows the single empty card and hides the table', () => {
  const spec = specFor(true, false) as unknown as { body: Array<{ when?: unknown }> }
  assert.deepEqual(
    spec.body[0]?.when,
    { $: 'isEmpty' },
    'the empty-state card must own the empty page',
  )
  assert.deepEqual(
    spec.body[1]?.when,
    { $: 'hasRows' },
    'the table must hide while nothing exists instead of repeating the empty card',
  )
})
