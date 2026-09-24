import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isPositiveKanbanAmount, sumKanbanColumnByCurrency } from './crm-kanban-totals'

const cad100 = { currency: 'CAD', projectedAmount: '100.0000', weightedAmount: '50.0000' }
const usd100 = { currency: 'USD', projectedAmount: '100.0000', weightedAmount: '25.0000' }

test('mixed-currency columns total per currency in either row order', () => {
  const forward = sumKanbanColumnByCurrency([cad100, usd100])
  const reversed = sumKanbanColumnByCurrency([usd100, cad100])
  assert.deepEqual(forward, [
    { currency: 'CAD', projected: '100.0000', weighted: '50.0000' },
    { currency: 'USD', projected: '100.0000', weighted: '25.0000' },
  ])
  assert.deepEqual(reversed, forward)
})

test('fractional and above-2^53 amounts sum exactly, never through float', () => {
  const totals = sumKanbanColumnByCurrency([
    { currency: 'USD', projectedAmount: '0.1000', weightedAmount: '0.1000' },
    { currency: 'USD', projectedAmount: '0.2000', weightedAmount: '0.0000' },
    { currency: 'USD', projectedAmount: '9007199254740993.0000', weightedAmount: '0.0000' },
    { currency: 'USD', projectedAmount: '1.0000', weightedAmount: '0.0000' },
  ])
  assert.deepEqual(totals, [
    { currency: 'USD', projected: '9007199254740994.3000', weighted: '0.1000' },
  ])
})

test('a missing currency is refused instead of invented', () => {
  assert.throws(
    () => sumKanbanColumnByCurrency([{ currency: '', projectedAmount: '1.0000', weightedAmount: '1.0000' }]),
    /currency/,
  )
})

test('positivity is exact, not float-approximated', () => {
  assert.equal(isPositiveKanbanAmount('0.0001'), true)
  assert.equal(isPositiveKanbanAmount('0.0000'), false)
  assert.equal(isPositiveKanbanAmount('-0.0001'), false)
})
