import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { REPORT_ENTITY_MAP } from './entities'
import { formatMeasureValue } from './run'

// F-t07-007: summarize-mode measures rendered kind-blind, so a date measure
// like min(due_date) printed as a datetime ("2026-06-30 04:00:00" — a UTC
// rendering of a local-midnight date). Date-kind measures must render dates.
describe('summarize measure display values', () => {
  const entity = REPORT_ENTITY_MAP.ledger_lines
  assert.ok(entity, 'ledger_lines entity must exist')
  const dueDate = { fn: 'min', column: 'due_date', label: 'Oldest due date' } as const

  it('renders a date-kind measure as a calendar date, never a datetime', () => {
    assert.equal(formatMeasureValue(entity, dueDate, new Date(2026, 5, 30)), '2026-06-30')
    assert.equal(formatMeasureValue(entity, dueDate, '2026-06-30'), '2026-06-30')
    assert.equal(formatMeasureValue(entity, dueDate, '2026-06-30T00:00:00.000Z'), '2026-06-30')
    assert.equal(formatMeasureValue(entity, dueDate, null), null)
  })

  it('leaves non-date measures exactly as shaped today', () => {
    assert.equal(
      formatMeasureValue(entity, { fn: 'sum', column: 'amount', label: 'Open' }, '314612.25'),
      '314612.25',
    )
    assert.equal(formatMeasureValue(entity, { fn: 'count', label: 'Lines' }, 28), 28)
  })
})
