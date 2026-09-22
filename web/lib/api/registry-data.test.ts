import assert from 'node:assert/strict'
import test from 'node:test'

const {
  API_RECORD_TYPES,
  V1_RESERVED_STATIC_SEGMENTS,
  resolveDocumentReadKinds,
  toResolved,
  v1PrettyResourcePath,
} = await import('./registry-data.ts')
const { DOCUMENT_CREATE_KINDS } = await import('../document-kinds.ts')

test('resolveDocumentReadKinds returns null off the documents table', () => {
  for (const key of ['journal-entries', 'parties', 'accounts', 'items', 'projects', 'assets']) {
    const entry = API_RECORD_TYPES.find((t) => t.key === key)
    assert.ok(entry, `${key} is a built-in record type`)
    assert.equal(resolveDocumentReadKinds(entry!), null, `${key} reads no documents rows`)
    assert.equal(toResolved(entry!).documentKinds, null)
  }
})

test('document writers resolve their own docKind as the read scope', () => {
  const writers = API_RECORD_TYPES.filter((entry) => entry.writer.kind === 'document')
  assert.ok(writers.length >= 2, 'the catalog must publish more than bills and invoices')
  for (const entry of writers) {
    assert.equal(entry.writer.kind, 'document')
    assert.deepEqual([...resolveDocumentReadKinds(entry)!], [entry.writer.docKind])
    assert.deepEqual([...toResolved(entry).documentKinds!], [entry.writer.docKind])
  }
  const bills = API_RECORD_TYPES.find((t) => t.key === 'bills')
  const invoices = API_RECORD_TYPES.find((t) => t.key === 'invoices')
  assert.equal(bills?.writer.kind, 'document')
  assert.equal(invoices?.writer.kind, 'document')
  if (bills?.writer.kind === 'document') assert.equal(bills.writer.docKind, 'vendor_bill')
  if (invoices?.writer.kind === 'document') assert.equal(invoices.writer.docKind, 'customer_invoice')
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

test('every unsaved-create document kind has a writable REST type', () => {
  for (const kind of DOCUMENT_CREATE_KINDS) {
    const entry = API_RECORD_TYPES.find((type) => type.writer.kind === 'document' && type.writer.docKind === kind)
    assert.ok(entry, `${kind} must have a writable REST record type`)
    assert.ok(entry.operations.includes('create') && entry.operations.includes('update'))
    assert.ok(entry.writePermission, `${kind} must advertise a write permission`)
  }
})

test('transaction document kinds used across the product have a REST type', () => {
  const kinds = [
    'vendor_bill', 'vendor_credit', 'vendor_payment', 'customer_invoice', 'customer_credit',
    'customer_payment', 'card_charge', 'card_refund', 'check', 'deposit', 'transfer',
    'journal', 'quote', 'sales_order', 'purchase_order', 'sales_fulfillment', 'purchase_receipt',
    'expense_report', 'field_ticket', 'pay_run', 'project_charge',
  ]
  for (const kind of kinds) {
    const covered = API_RECORD_TYPES.some((type) =>
      (type.writer.kind === 'document' && type.writer.docKind === kind)
      || Boolean(type.documentKinds?.includes(kind)),
    )
    assert.ok(covered, `${kind} must be listable through a REST record type`)
  }
})

test('record type keys do not shadow reserved v1 folders, and pretty paths exist otherwise', () => {
  const reserved = new Set<string>(V1_RESERVED_STATIC_SEGMENTS)
  for (const entry of API_RECORD_TYPES) {
    assert.equal(reserved.has(entry.key), false, `${entry.key} would shadow /api/v1/${entry.key}`)
    assert.equal(v1PrettyResourcePath(entry.key), `/api/v1/${entry.key}`)
  }
  for (const segment of V1_RESERVED_STATIC_SEGMENTS) {
    assert.equal(v1PrettyResourcePath(segment), null)
  }
})
