import assert from 'node:assert/strict'
import test from 'node:test'

const {
  API_RECORD_TYPES,
  resolveDocumentReadKinds,
  toResolved,
} = await import('./registry-data.ts')

test('resolveDocumentReadKinds returns null off the documents table', () => {
  for (const key of ['journal-entries', 'parties', 'accounts', 'items', 'projects', 'assets']) {
    const entry = API_RECORD_TYPES.find((t) => t.key === key)
    assert.ok(entry, `${key} is a built-in record type`)
    assert.equal(resolveDocumentReadKinds(entry!), null, `${key} reads no documents rows`)
    assert.equal(toResolved(entry!).documentKinds, null)
  }
})

test('document writers resolve their own docKind as the read scope', () => {
  for (const key of ['bills', 'invoices']) {
    const entry = API_RECORD_TYPES.find((t) => t.key === key)
    assert.ok(entry)
    assert.equal(entry!.writer.kind, 'document')
    assert.deepEqual([...resolveDocumentReadKinds(entry!)!], [entry!.writer.docKind])
    assert.deepEqual([...toResolved(entry!).documentKinds!], [key === 'bills' ? 'vendor_bill' : 'customer_invoice'])
  }
})

test('a documents-backed readonly writer must declare its kind allowlist', () => {
  const payments = API_RECORD_TYPES.find((t) => t.key === 'payments')
  assert.ok(payments)
  assert.equal(payments.table, 'documents')
  assert.equal(payments.writer.kind, 'readonly')
  assert.deepEqual(
    [...resolveDocumentReadKinds(payments!)!],
    ['vendor_payment', 'customer_payment'],
    'payments read exactly the two payment kinds — never bills or invoices',
  )
  assert.deepEqual(
    [...toResolved(payments!).documentKinds!],
    ['vendor_payment', 'customer_payment'],
  )
})

test('the allowlist fails closed on empty, blank, or duplicated kinds', () => {
  const base = {
    key: 'x',
    label: 'X',
    description: 'x',
    table: 'documents',
    searchColumn: 'document_number',
    readPermission: 'r',
    writePermission: null,
    operations: ['list' as const],
    writer: { kind: 'readonly' as const },
    dynamic: false,
  }
  assert.throws(() => resolveDocumentReadKinds({ ...base }), /nonempty document kind scope/, 'missing kinds')
  assert.throws(() => resolveDocumentReadKinds({ ...base, documentKinds: [] }), /nonempty document kind scope/)
  assert.throws(() => resolveDocumentReadKinds({ ...base, documentKinds: ['vendor_payment', '   '] }), /nonempty document kind scope/)
  assert.deepEqual(
    [...resolveDocumentReadKinds({ ...base, documentKinds: ['vendor_payment', 'vendor_payment'] })!],
    ['vendor_payment'],
    'kinds dedupe so the SQL allowlist stays minimal',
  )
})

test('every built-in record type resolves without throwing', () => {
  // A documents-backed entry added later without a kind scope must fail loudly
  // here instead of silently reading across every document kind.
  for (const entry of API_RECORD_TYPES) {
    if (!entry.table) continue
    const resolved = toResolved(entry)
    assert.ok(resolved.key === entry.key)
    assert.ok(resolved.documentKinds === null || resolved.documentKinds.length > 0)
  }
})
