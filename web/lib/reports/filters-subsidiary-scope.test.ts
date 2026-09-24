import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { dimensionOptionsScope } = await import('./filters')

test('report dimension options retain caller scope when consolidation rates are unavailable', () => {
  const allowed = new Set(['sub-a'])
  const empty = new Set<string>()
  assert.equal(dimensionOptionsScope(undefined, allowed), allowed)
  assert.equal(dimensionOptionsScope(undefined, empty), empty)
  assert.equal(dimensionOptionsScope(undefined, null), undefined)
  assert.deepEqual(dimensionOptionsScope(['sub-a'], allowed), ['sub-a'])
})
