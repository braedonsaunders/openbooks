import assert from 'node:assert/strict'
import test from 'node:test'
import { menuColumns } from './menu-columns'
import { defaultNavConfig, MODULE_BY_KEY, isDefaultLocalNavigationItem } from '@openbooks/engine/navigation'
import { toBlocks } from '../../components/sidebar-nav'

test('Customers places Sales Overview beneath Pipeline in the left column', () => {
  const customers = defaultNavConfig().groups.find((group) => group.id === 'customers')!
  const items = customers.items.flatMap((item) => {
    if (item.kind !== 'module') return []
    const module = MODULE_BY_KEY.get(item.moduleKey)!
    return [{ href: module.href, label: module.label, iconKey: module.iconKey, subgroup: module.subgroup }]
  })
  const columns = menuColumns(toBlocks(items), (block) => block.kind === 'subgroup' ? block.items.length + 1.5 : 1)
  assert.deepEqual(columns.map((column) => column.map((block) => block.kind === 'subgroup' ? block.label : block.item.label)), [
    ['relationships', 'pipeline', 'crm-sales'], ['sell-collect'],
  ])
  const sales = columns[0]!.find((block) => block.kind === 'subgroup' && block.label === 'crm-sales')!
  assert.equal(sales.kind, 'subgroup')
  if (sales.kind !== 'subgroup') throw new Error('Sales must be a subgroup')
  assert.equal(sales.items[0]!.href, '/crm/sales')
  assert.equal(sales.items[0]!.label, 'Overview')
})

test('People defaults place Benefits, Payroll and Payroll controls in the right column', () => {
  const people = defaultNavConfig().groups.find(group => group.id === 'hrm')!
  const blocks = toBlocks(people.items.filter(item => !isDefaultLocalNavigationItem(people.id, item)).flatMap(item => {
    const module = item.kind === 'module' ? MODULE_BY_KEY.get(item.moduleKey) : undefined
    return module ? [{ href: module.href, label: module.label, iconKey: module.iconKey, subgroup: module.subgroup }] : []
  }))
  const columns = menuColumns(blocks, block => block.kind === 'subgroup' ? block.items.length + 1.5 : 1)
  assert.equal(columns.length, 2)
  assert.deepEqual(columns.flat(), blocks, 'column reading order preserves the saved menu order')
  assert.deepEqual(columns.map((column) => column.map((block) => block.kind === 'subgroup' ? block.label : block.item.label)), [
    ['workforce', 'hrm-talent', 'hrm-timeOff', 'hrm-compensation'], ['hrm-benefits', 'payroll-work', 'payroll-controls'],
  ])
  const weights = columns.map((column) => column.reduce((sum, block) => sum + (block.kind === 'subgroup' ? block.items.length + 1.5 : 1), 0))
  assert.equal(Math.max(...weights), 22)
})

test('a single section never leaves an empty second column', () => {
  assert.deepEqual(menuColumns([{ label: 'Payroll', count: 6 }], (block) => block.count), [[{ label: 'Payroll', count: 6 }]])
  assert.deepEqual(menuColumns([], () => 1), [[]])
})
