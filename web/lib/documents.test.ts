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

const { DocumentEditError, validateEditableDocumentLines, validateCorrectionReason, buildReversalLinkEvidence } =
  await import('./documents.ts')
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

test('reversal link evidence carries the full mandatory audit contract', () => {
  const before = new Date('2026-08-24T00:00:00Z')
  const link = buildReversalLinkEvidence({
    fromDocumentId: 'replacement-1',
    toDocumentId: 'source-1',
    reason: '  mis-keyed vendor on the original bill  ',
    requestedBy: 'user-1',
  })
  assert.equal(link.linkType, 'reverses')
  assert.equal(link.fromDocumentId, 'replacement-1')
  assert.equal(link.toDocumentId, 'source-1')
  assert.equal(link.reason, 'mis-keyed vendor on the original bill')
  assert.equal(link.requestedBy, 'user-1')
  assert.ok(link.requestedAt instanceof Date && link.requestedAt >= before)
})

test('a reversal link cannot be constructed without the evidence the database mandates', () => {
  // The document_links_reversal_evidence CHECK refuses any 'reverses' edge
  // whose btrimmed reason falls outside 8..500 or whose requester is null —
  // so this seam must reject exactly those inputs instead of letting the
  // insert abort the whole correction transaction with a constraint error.
  const base = { fromDocumentId: 'r1', toDocumentId: 's1' }
  for (const bad of ['short', '       ', '', 'x'.repeat(501), undefined, null]) {
    assert.throws(
      () => buildReversalLinkEvidence({ ...base, reason: bad as string | null | undefined, requestedBy: 'user-1' }),
      (e: unknown) =>
        e instanceof DocumentEditError && e.status === 422 && /8 and 500/.test(e.message),
      `reason ${JSON.stringify(bad)} must be rejected`,
    )
  }
  assert.equal(validateCorrectionReason(`  ${'y'.repeat(500)}  `).length, 500)

  assert.throws(
    () => buildReversalLinkEvidence({ ...base, reason: 'a perfectly valid reason', requestedBy: '' }),
    (e: unknown) => e instanceof DocumentEditError && e.status === 422 && /attributable requester/.test(e.message),
  )
  assert.throws(
    () => buildReversalLinkEvidence({ ...base, fromDocumentId: '', toDocumentId: 's1', reason: 'a perfectly valid reason', requestedBy: 'u1' }),
    (e: unknown) => e instanceof DocumentEditError && e.status === 422 && /both the replacement and the corrected/.test(e.message),
  )
})

test("the posted-correction path records its reverses edge through the mandatory-evidence builder", () => {
  // Regression pin (source-level): createPostedCorrectionDraft used to insert
  // a bare 'reverses' edge — no reason, requester, or timestamp — which the
  // database's document_links_reversal_evidence CHECK now rejects outright.
  // The only 'reverses' literal in web/lib/documents.ts must live inside the
  // evidence builder, and the correction transaction must compose it.
  const source = readFileSync(new URL('./documents.ts', import.meta.url), 'utf8')
  assert.match(source, /\.\.\.buildReversalLinkEvidence\(/)
  // Inside the correction transaction itself, the edge must be composed from
  // the builder — no hand-rolled linkType line may exist there.
  const fn = source.match(/export async function createPostedCorrectionDraft[\s\S]*?\n\}/)
  assert.ok(fn, 'createPostedCorrectionDraft found')
  assert.doesNotMatch(fn[0], /linkType:/)
})
