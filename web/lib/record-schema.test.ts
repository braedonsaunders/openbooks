// Run with:  node --import tsx --test web/lib/record-schema.test.ts   (from repo root)
//
// Unit tests for the section-aware record-type helpers: canonical validation,
// linting header + repeating (line-list) sections with rollup formulas, the
// merged-data ⇄ (values, rows) split, unknown-key stripping, value validation
// (incl. repeating minRows), and live formula/rollup computation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FormSection } from '@openbooks/forms-core'
import {
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
const SECTIONS: FormSection[] = [
  {
    id: 'main',
    title: 'Details',
    fields: [
      { id: 'name', type: 'text', label: 'Name' },
      {
        id: 'grand_total',
        type: 'formula',
        label: 'Grand total',
        config: { format: 'currency' },
        formula: { kind: 'sum', of: [{ kind: 'sum_section', sectionKey: 'lines', rowFieldKey: 'amount' }] },
      },
    ],
  },
  {
    id: 'lines',
    title: 'Lines',
    repeating: true,
    minRows: 1,
    fields: [
      { id: 'desc', type: 'text', label: 'Description' },
      { id: 'qty', type: 'number', label: 'Qty' },
      { id: 'price', type: 'currency', label: 'Price' },
      {
        id: 'amount',
        type: 'formula',
        label: 'Amount',
        config: { format: 'currency' },
        formula: {
          kind: 'product',
          of: [
            { kind: 'field_ref', fieldKey: 'qty' },
            { kind: 'field_ref', fieldKey: 'price' },
          ],
        },
      },
    ],
  },
]

test('flat custom-record field definitions are rejected by the canonical section model', () => {
  const flat = [
    { id: 'a', type: 'text', label: 'A' },
    { id: 'b', type: 'number', label: 'B' },
  ]
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

test('lintRecordFields flags a duplicate id across sections', () => {
  const dup: FormSection[] = [
    { id: 's1', fields: [{ id: 'shared', type: 'text', label: 'A' }] },
    { id: 's2', repeating: true, fields: [{ id: 'shared', type: 'text', label: 'B' }] },
  ]
  const lint = lintRecordFields(dup, 'X')
  assert.equal(lint.success, true)
  if (!lint.success) return
  assert.ok(lint.issues.some((i) => /[Dd]uplicate/.test(i.message)))
})

test('lintRecordFields rejects a field type not allowed on records', () => {
  const bad: FormSection[] = [
    { id: 's1', fields: [{ id: 'sig', type: 'signature', label: 'Sign' }] },
  ]
  const lint = lintRecordFields(bad, 'X')
  assert.equal(lint.success, true)
  if (!lint.success) return
  assert.ok(lint.issues.some((i) => i.message.includes('not available on custom records')))
})

test('lintRecordFields flags a rollup that references an unknown section', () => {
  const bad: FormSection[] = [
    {
      id: 'main',
      fields: [
        {
          id: 'total',
          type: 'formula',
          label: 'T',
          formula: { kind: 'sum_section', sectionKey: 'missing', rowFieldKey: 'x' },
        },
      ],
    },
  ]
  const lint = lintRecordFields(bad, 'X')
  assert.equal(lint.success, true)
  if (!lint.success) return
  assert.ok(lint.issues.some((i) => /unknown repeating section/.test(i.message)))
})

test('lintRecordFields flags repeating minRows > maxRows', () => {
  const bad: FormSection[] = [
    { id: 'lines', repeating: true, minRows: 5, maxRows: 2, fields: [{ id: 'a', type: 'text', label: 'A' }] },
  ]
  const lint = lintRecordFields(bad, 'X')
  assert.equal(lint.success, true)
  if (!lint.success) return
  assert.ok(lint.issues.some((i) => /maxRows/.test(i.message)))
})

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
