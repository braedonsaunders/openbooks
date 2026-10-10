import assert from 'node:assert/strict'
import test from 'node:test'
import { previewPostedCorrection } from './posted-correction-preview.ts'

// The drawer consequence preview shares the engine classification: what it
// promises (metadata vs reclass vs void-and-reissue) is what the correct
// route enforces. These pin the mapping without a database.
const doc = {
  party_id: 'party-1',
  document_date: '2026-07-14',
  currency: 'CAD',
  memo: null,
  reference_number: null,
  department_id: null,
  project_id: 'project-a',
  location_id: null,
  class_id: null,
  custom: {},
  extra_dims: {},
}

const storedLines = [
  {
    account_id: 'revenue', item_id: null, description: 'Services',
    quantity: '1.00000000', unit: null, unit_price: '4200.00000000',
    amount: '4200.0000', tax_code_id: null, tax_group_id: null,
    tax_input_amount: '4200.0000', tax_amount: '0.0000', tax_overridden: false,
    party_id: null, department_id: null, project_id: null,
    location_id: null, class_id: null, work_from: null, work_to: null,
    custom: {},
  },
]

const payloadLine = {
  lineId: 'line-1',
  accountId: 'revenue',
  itemId: null,
  description: 'Services',
  quantity: '1',
  unit: null,
  unitPrice: '4200',
  amount: '4200',
  taxCodeId: null,
  taxGroupId: null,
  taxOverridden: false,
  taxAmount: null,
  partyId: null,
  departmentId: null,
  projectId: null,
  locationId: null,
  classId: null,
}

test('an untouched payload previews a metadata correction', () => {
  assert.equal(
    previewPostedCorrection({
      doc,
      storedLines,
      payload: { memo: null, projectId: 'project-a', custom: {}, lines: [payloadLine] },
    }),
    'metadata-correction',
  )
})

test('a memo edit previews a metadata correction', () => {
  assert.equal(
    previewPostedCorrection({
      doc,
      storedLines,
      payload: { memo: 'Add the PO reference', custom: {}, lines: [payloadLine] },
    }),
    'metadata-correction',
  )
})

test('a project edit previews a reclass', () => {
  assert.equal(
    previewPostedCorrection({
      doc,
      storedLines,
      payload: { projectId: 'project-b', custom: {}, lines: [payloadLine] },
    }),
    'reclass',
  )
})

test('an amount edit previews void-and-reissue', () => {
  assert.equal(
    previewPostedCorrection({
      doc,
      storedLines,
      payload: { custom: {}, lines: [{ ...payloadLine, amount: '5000' }] },
    }),
    'void-and-reissue',
  )
})

test('a line removal previews void-and-reissue', () => {
  assert.equal(
    previewPostedCorrection({ doc, storedLines, payload: { custom: {}, lines: [] } }),
    'void-and-reissue',
  )
})
