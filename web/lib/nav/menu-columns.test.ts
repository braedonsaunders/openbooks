import assert from 'node:assert/strict'
import test from 'node:test'
import { menuColumns } from './menu-columns'

test('uneven People sections form compact independent columns in reading order', () => {
  const blocks = [
    { label: 'Workforce', items: 4 }, { label: 'Hiring', items: 2 },
    { label: 'Time Off', items: 1 }, { label: 'Talent', items: 1 },
    { label: 'Rewards', items: 1 }, { label: 'Payroll', items: 6 },
    { label: 'Payroll Controls', items: 4 },
  ]
  const columns = menuColumns(blocks, (block) => block.items + 1.5)
  assert.equal(columns.length, 2)
  assert.deepEqual(columns.flat(), blocks, 'column reading order preserves the saved menu order')
  assert.deepEqual(columns.map((column) => column.map((block) => block.label)), [
    ['Workforce', 'Hiring', 'Time Off', 'Talent'], ['Rewards', 'Payroll', 'Payroll Controls'],
  ])
  const weights = columns.map((column) => column.reduce((sum, block) => sum + block.items + 1.5, 0))
  assert.equal(Math.max(...weights), 15.5)
})

test('a single section never leaves an empty second column', () => {
  assert.deepEqual(menuColumns([{ label: 'Payroll', count: 6 }], (block) => block.count), [[{ label: 'Payroll', count: 6 }]])
  assert.deepEqual(menuColumns([], () => 1), [[]])
})
