import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// documents.ts and bills.ts are server-only services (they pull the engine's
// DB pool and the flows engine), so the runner cannot import them as-is. The
// marker package gates only RSC bundling; shimming it to an empty module lets
// these tests exercise the modules' pure seams directly. node's test runner
// isolates each file in its own process, so the hook cannot leak elsewhere.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { DocumentEditError, validateEditableDocumentLines } = await import('./documents.ts')
const { computeBillTotals } = await import('./bills.ts')

const NO_PROFILES = { codes: new Map(), groups: new Map() }

test('negative and zero lines survive editor validation untouched', () => {
  const lines = validateEditableDocumentLines([
    { accountId: 'acc-1', amount: '100.00' },
    { accountId: 'acc-2', amount: '-40.00' },
    { accountId: 'acc-3', amount: '0' },
  ])
  assert.deepEqual(lines.map((l) => l.amount), ['100.00', '-40.00', '0'])
})

test('a line without an account fails closed with its line number', () => {
  assert.throws(
    () => validateEditableDocumentLines([
      { accountId: 'acc-1', amount: '10.00' },
      { accountId: null, amount: '5.00' } as never,
    ]),
    (e: unknown) =>
      e instanceof DocumentEditError && e.status === 422 && /Line 2/.test(e.message),
  )
})

test('a malformed or over-precise amount fails closed with its line number', () => {
  for (const [index, bad] of ['12ab', '', '1.00001'].entries()) {
    assert.throws(
      () => validateEditableDocumentLines([{ accountId: 'acc-1', amount: bad }]),
      (e: unknown) => e instanceof DocumentEditError && e.status === 422 && /Line 1/.test(e.message),
      `amount ${JSON.stringify(bad)} (case ${index}) should be rejected`,
    )
  }
})

test('computeBillTotals carries negative and zero lines into the totals', () => {
  const computed = computeBillTotals([
    { accountId: 'acc-1', amount: '100.00' },
    { accountId: 'acc-2', amount: '-40.00' },
    { accountId: 'acc-3', amount: '0' },
  ], NO_PROFILES)
  assert.equal(computed.subtotal, '60.0000')
  assert.equal(computed.taxTotal, '0.0000')
  assert.equal(computed.total, '60.0000')
})

test('the generic editor no longer filters lines by positive amount', () => {
  // Regression pin (source-level, like wip-billing.test.ts): the save path
  // must validate every submitted line, never silently drop non-positive ones.
  const source = readFileSync(new URL('./documents.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /const valid = body\.lines\.filter/)
})
