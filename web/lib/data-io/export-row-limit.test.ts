import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

// Every export read must fetch the sentinel row (MAX + 1) and gate on it.
// A bare `limit ${MAX_EXPORT_ROWS}` returns a complete-looking truncated
// file with no signal — the defect this slice removes.
const FAMILY_FILES = [
  'master-data-resources.ts',
  'record-resources.ts',
  'setup-resources.ts',
  'transaction-resources.ts',
  'property-resources.ts',
  'fixed-asset-resources.ts',
  'payroll-opening-balances-resource.ts',
  'prior-payroll-register-resource.ts',
]

for (const file of FAMILY_FILES) {
  test(`${file} gates its export read on the sentinel, never a bare cap`, async () => {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.match(source, /enforceExportRowLimit\(/)
    assert.match(source, /MAX_EXPORT_ROWS \+ 1/)
    assert.doesNotMatch(source, /limit \$\{MAX_EXPORT_ROWS\}/)
  })
}

test('test doubles re-export the real pure gate instead of copying it', async () => {
  // Repository rule: never mock pure validation. The resource-core doubles
  // re-export ./export-cap.ts; a copied class or function here is a failure.
  const doubles = [
    'import-route.test.ts',
    'master-data-resources.test.ts',
    'record-resources.test.ts',
    'transaction-resources.test.ts',
    'transaction-resources-distribution.test.ts',
  ]
  for (const file of doubles) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /class ExportRowLimitError/, file)
    assert.doesNotMatch(source, /function enforceExportRowLimit/, file)
    assert.match(source, /export \* from.*export-cap\.ts/, file)
  }
})

test('no resource family keeps a parallel copy of the cap', async () => {
  for (const file of FAMILY_FILES) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(
      source,
      /const MAX_EXPORT_ROWS = 50_000/,
      `${file} must reuse the canonical cap from resource-core.ts`,
    )
  }
})

test('in-memory setup sources refuse instead of slicing silently', async () => {
  const source = await readFile(new URL('./setup-resources.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /slice\(0, MAX_EXPORT_ROWS\)/)
})

test('the export route turns the refusal into a named 413, never a file', async () => {
  const route = await readFile(new URL('../../app/api/data/export/route.ts', import.meta.url), 'utf8')
  assert.match(route, /ExportRowLimitError/)
  assert.match(route, /status: 413/)
  // The error body is JSON on the refusal path — never a streamed file.
  assert.match(route, /NextResponse\.json\(\{ error: error\.message \}/)
})
