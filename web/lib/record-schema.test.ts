import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FormSection } from '@openbooks/forms-core'
import {
  findUnknownDataKeys,
  formatFieldValue,
  lintRecordFields,
  normalizeSectionsInput,
  splitRecordData,
  mergeRecordData,
  stripUnknownData,
  validateRecordData,
  withComputedFormulas,
} from './record-schema.ts'

// A representative type: a header group (with a rollup formula) + a repeating
// line list whose rows carry a per-row product formula.
type Field = FormSection['fields'][number]
const field = (id: string, type: Field['type'], label: string): Field => ({ id, type, label })
const ref = (fieldKey: string) => ({ kind: 'field_ref' as const, fieldKey })
const literal = (value: number) => ({ kind: 'literal' as const, value })
const formula = (id: string, label: string, value: Field['formula'], currency = false): Field => ({
  ...field(id, 'formula', label), formula: value, ...(currency ? { config: { format: 'currency' } } : {}),
})
const SECTIONS: FormSection[] = [
  { id: 'main', title: 'Details', fields: [
    field('name', 'text', 'Name'),
    formula('grand_total', 'Grand total', { kind: 'sum', of: [{ kind: 'sum_section', sectionKey: 'lines', rowFieldKey: 'amount' }] }, true),
  ] },
  { id: 'lines', title: 'Lines', repeating: true, minRows: 1, fields: [
    field('desc', 'text', 'Description'), field('qty', 'number', 'Qty'), field('price', 'currency', 'Price'),
    formula('amount', 'Amount', { kind: 'product', of: [ref('qty'), ref('price')] }, true),
  ] },
]

test('flat custom-record field definitions are rejected by the canonical section model', () => {
  const flat = [field('a', 'text', 'A'), field('b', 'number', 'B')]
  assert.equal(lintRecordFields(flat, 'Asset').success, false)
})

test('normalizeSectionsInput passes a section array through and returns [] for empty', () => {
  assert.deepEqual(normalizeSectionsInput([]), [])
  const out = normalizeSectionsInput(SECTIONS) as FormSection[]
  assert.equal(out.length, 2)
  assert.equal(out[1]!.repeating, true)
})

test('lintRecordFields accepts header + repeating sections with a valid rollup', () => {
  const lint = lintRecordFields(SECTIONS, 'Order')
  assert.equal(lint.success, true)
  if (!lint.success) return
  assert.equal(lint.issues.length, 0, JSON.stringify(lint.issues))
  assert.equal(lint.sections.length, 2)
  // flattened field list spans every section
  assert.deepEqual(
    lint.fields.map((f) => f.id).sort(),
    ['amount', 'desc', 'grand_total', 'name', 'price', 'qty'],
  )
})

const lintCases: Array<[string, FormSection[], RegExp]> = [
  ['lintRecordFields flags a duplicate id across sections', [
    { id: 's1', fields: [field('shared', 'text', 'A')] },
    { id: 's2', repeating: true, fields: [field('shared', 'text', 'B')] },
  ], /[Dd]uplicate/],
  ['lintRecordFields rejects a field type not allowed on records', [
    { id: 's1', fields: [field('sig', 'signature', 'Sign')] },
  ], /not available on custom records/],
  ['lintRecordFields flags a rollup that references an unknown section', [
    { id: 'main', fields: [formula('total', 'T', { kind: 'sum_section', sectionKey: 'missing', rowFieldKey: 'x' })] },
  ], /unknown repeating section/],
  ['lintRecordFields flags repeating minRows > maxRows', [
    { id: 'lines', repeating: true, minRows: 5, maxRows: 2, fields: [field('a', 'text', 'A')] },
  ], /maxRows/],
]
for (const [title, sections, message] of lintCases) {
  test(title, () => {
    const lint = lintRecordFields(sections, 'X')
    assert.equal(lint.success, true)
    if (!lint.success) return
    assert.ok(lint.issues.some(issue => message.test(issue.message)))
  })
}

test('splitRecordData / mergeRecordData round-trip header vs rows', () => {
  const data = { name: 'Widget', lines: [{ qty: 2, price: 3 }], stray: 'x' }
  const { values, rows } = splitRecordData(SECTIONS, data)
  assert.deepEqual(values, { name: 'Widget', stray: 'x' })
  assert.deepEqual(rows, { lines: [{ qty: 2, price: 3 }] })
  assert.deepEqual(mergeRecordData(values, rows), data)
})

test('splitRecordData coerces a non-array repeating value to []', () => {
  const { rows } = splitRecordData(SECTIONS, { lines: 'oops' })
  assert.deepEqual(rows.lines, [])
})

test('stripUnknownData drops unknown header keys, unknown row fields, and bad rows', () => {
  const dirty = {
    name: 'ok',
    removed_header: 1,
    lines: [
      { qty: 1, price: 2, ghost: 9 },
      'not-an-object',
    ],
  }
  const clean = stripUnknownData(SECTIONS, dirty)
  assert.deepEqual(clean, { name: 'ok', lines: [{ qty: 1, price: 2 }, {}] })
})

test('findUnknownDataKeys names undeclared ids before stripping can hide them', () => {
  // Declared ids (header fields, the lines section, row fields) pass clean.
  assert.deepEqual(findUnknownDataKeys(SECTIONS, { name: 'ok', lines: [{ qty: 1, price: 2 }] }), [])
  assert.deepEqual(findUnknownDataKeys(SECTIONS, { removed_header: 1 }), ['removed_header'])
  assert.deepEqual(findUnknownDataKeys(SECTIONS, { ghost_section: [] }), ['ghost_section'])
  assert.deepEqual(findUnknownDataKeys(SECTIONS, { lines: [{ qty: 1, ghost: 9 }] }), ['lines[0].ghost'])
  // A non-array under a repeating id is a shape error for the validator,
  // not an unknown key.
  assert.deepEqual(findUnknownDataKeys(SECTIONS, { lines: 'oops' }), [])
})

test('validateRecordData enforces repeating minRows only at submit', () => {
  const empty = { name: 'x', lines: [] }
  assert.equal(validateRecordData(SECTIONS, empty, 'draft').length, 0)
  const submit = validateRecordData(SECTIONS, empty, 'submit')
  assert.ok(submit.some((e) => e.sectionId === 'lines'))
})

test('validateRecordData rejects an unknown top-level key', () => {
  const errs = validateRecordData(SECTIONS, { name: 'x', lines: [{}], bogus: 1 }, 'draft')
  assert.ok(errs.some((e) => e.fieldId === 'bogus' && /[Uu]nknown/.test(e.message)))
})

test('withComputedFormulas computes per-row formulas and the header rollup', () => {
  const data = {
    name: 'Order',
    lines: [
      { qty: 2, price: 5 },
      { qty: 3, price: 10 },
    ],
  }
  const out = withComputedFormulas(SECTIONS, data)
  const lines = out.lines as Array<Record<string, unknown>>
  assert.equal(lines[0]!.amount, 10) // 2 * 5
  assert.equal(lines[1]!.amount, 30) // 3 * 10
  assert.equal(out.grand_total, 40) // sum of amounts
})

test('formatFieldValue formats currency without a float round-trip', () => {
  const price = { id: 'price', type: 'currency', label: 'Price' } as const
  // Past 2^53 the double cannot hold the cents: the exact ledger string must
  // reach Intl, exactly as pdfMoney and the statement renderer do.
  assert.equal(formatFieldValue(price, '12345678901234567.89'), '12,345,678,901,234,567.89')
  assert.equal(formatFieldValue(price, '99999999999999.99'), '99,999,999,999,999.99')
  // The 2.675 case pdfMoney's own comment cites: the exact decimal rounds up.
  assert.equal(formatFieldValue(price, '2.675'), '2.68')
  // Negative zero collapses, matching the sibling money paths.
  assert.equal(formatFieldValue(price, '-0.0000'), '0.00')
  // Ordinary values are untouched by the exact path.
  assert.equal(formatFieldValue(price, '1234.5'), '1,234.50')
  assert.equal(formatFieldValue(price, 42), '42.00')
})

test('formatFieldValue formats percentages without a float round-trip', () => {
  const pct = { id: 'rate', type: 'percentage', label: 'Rate' } as const
  assert.equal(formatFieldValue(pct, '2.675'), '2.68%')
  assert.equal(formatFieldValue(pct, '99999999999999.99'), '99,999,999,999,999.99%')
  assert.equal(formatFieldValue(pct, '5'), '5%')
})

test('withComputedFormulas resolves chained formulas in headers and repeating rows', () => {
  const sections: FormSection[] = [
    { id: 'main', title: 'Details', fields: [
      field('base', 'number', 'Base'),
      formula('plus_one', 'Plus one', { kind: 'sum', of: [ref('double'), literal(1)] }),
      formula('double', 'Double', { kind: 'product', of: [ref('base'), literal(2)] }),
    ] },
    { id: 'lines', title: 'Lines', repeating: true, fields: [
      field('qty', 'number', 'Qty'),
      formula('row_plus_one', 'Plus one', { kind: 'sum', of: [ref('row_double_qty'), literal(1)] }),
      formula('row_double_qty', 'Double quantity', { kind: 'product', of: [ref('qty'), literal(2)] }),
    ] },
  ]

  const out = withComputedFormulas(sections, {
    base: 5,
    // Simulate an edit where previously persisted formula values are stale.
    double: 999,
    lines: [{ qty: 4, row_double_qty: 999 }],
  })
  assert.equal(out.plus_one, 11)
  assert.equal(out.double, 10)
  assert.equal((out.lines as Array<Record<string, unknown>>)[0]!.row_plus_one, 9)
  assert.equal((out.lines as Array<Record<string, unknown>>)[0]!.row_double_qty, 8)
})
