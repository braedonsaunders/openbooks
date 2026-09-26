import assert from 'node:assert/strict'
import test from 'node:test'

const { dimensionOptionsScope } = await import('./filters')

test('report dimension options retain caller scope when consolidation rates are unavailable', () => {
  const allowed = new Set(['sub-a'])
  const empty = new Set<string>()
  assert.equal(dimensionOptionsScope(undefined, allowed), allowed)
  assert.equal(dimensionOptionsScope(undefined, empty), empty)
  assert.equal(dimensionOptionsScope(undefined, null), undefined)
  assert.deepEqual(dimensionOptionsScope(['sub-a'], allowed), ['sub-a'])
})
