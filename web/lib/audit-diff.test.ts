import assert from 'node:assert/strict'
import test from 'node:test'
import { auditEventDiffs } from './audit-diff.ts'

test('journal line changes are expanded to the specific line and field', () => {
  const diffs = auditEventDiffs({
    before: {
      document: { memo: 'Before', updated_at: '2026-01-01' },
      lines: [
        { id: 'old-id', line_number: 1, account_id: 'cash', amount: '10.0000' },
        { id: 'old-id-2', line_number: 2, account_id: 'sales', amount: '-10.0000' },
      ],
    },
    after: {
      document: { memo: 'After', updated_at: '2026-01-02' },
      lines: [
        { id: 'new-id', line_number: 1, account_id: 'cash', amount: '15.0000' },
        { id: 'new-id-2', line_number: 2, account_id: 'sales', amount: '-15.0000' },
      ],
    },
  })

  assert.deepEqual(diffs, [
    { path: 'document.memo', before: 'Before', after: 'After' },
    { path: 'lines.Line 1.amount', before: '10.0000', after: '15.0000' },
    { path: 'lines.Line 2.amount', before: '-10.0000', after: '-15.0000' },
  ])
})

test('legacy field-pair events still produce before and after values', () => {
  assert.deepEqual(auditEventDiffs({
    source: 'ui',
    status: ['draft', 'posted'],
  }), [
    { path: 'status', before: 'draft', after: 'posted' },
  ])
})
