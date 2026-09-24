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

const {
  enforceExportRowLimit,
  ExportRowLimitError,
  MAX_EXPORT_ROWS,
} = (await import('./resource-core.ts')) as typeof import('./resource-core.ts')

test('the export cap is exactly 50,000 rows', () => {
  assert.equal(MAX_EXPORT_ROWS, 50_000)
})

test('exactly at the cap succeeds — the sentinel must not false-positive', () => {
  const rows = Array.from({ length: MAX_EXPORT_ROWS }, (_, i) => ({ n: i }))
  assert.equal(enforceExportRowLimit(rows, 'Parties').length, MAX_EXPORT_ROWS)
})

test('one row past the cap refuses by name with a remedy that exists', () => {
  const rows = Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, i) => ({ n: i }))
  assert.throws(() => enforceExportRowLimit(rows, 'Parties'), (error: unknown) => {
    assert.ok(error instanceof ExportRowLimitError)
    const err = error as InstanceType<typeof ExportRowLimitError>
    assert.equal(err.code, 'EXPORT_ROW_LIMIT_EXCEEDED')
    assert.equal(err.resourceLabel, 'Parties')
    assert.equal(err.limit, MAX_EXPORT_ROWS)
    // Names the resource and the limit; states plainly that the export
    // cannot be narrowed (no shipped control shrinks the row set) and
    // points at the administrator instead of inventing a filter.
    assert.match(err.message, /"Parties"/)
    assert.match(err.message, /50,000/)
    assert.match(err.message, /cannot be narrowed/)
    assert.match(err.message, /contact your administrator/)
    assert.doesNotMatch(err.message, /subsidiary/)
    return true
  })
})
