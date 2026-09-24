import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { REPORT_FILTER_OPERATORS } from '@openbooks/reports'

// custom-reports is server-only in production; this suite runs the one pure
// export it needs with that guard stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { TEMPORAL_OPS } = await import('./custom-reports.ts')

test('every viewer-override temporal op is a real filter operator', () => {
  // E47: a dead 'between' sat in the override set while no compiler or
  // validator accepts it, so the set claimed to govern filters that can
  // never exist. The set must stay within the valid operators.
  const valid = new Set<string>(REPORT_FILTER_OPERATORS as readonly string[])
  for (const op of TEMPORAL_OPS) {
    assert.ok(valid.has(op), `TEMPORAL_OPS member '${op}' is not a valid filter operator`)
  }
  assert.ok(!TEMPORAL_OPS.has('between'), "'between' compiles nowhere and must stay out of the override set")
})
