import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultFormLayout, parseFormLayout } from '@openbooks/customization'
import { essentialsFormLayout } from './customization/essentials-form'
import { essentialsNavConfig } from './nav/essentials'
import { defaultNavConfig } from './nav/registry'
import { essentialsDefaultLayout } from '../app/(app)/dashboard/_essentials-layout'
import { DashboardLayoutInputSchema, clampToWidgetMinimums } from '../app/(app)/dashboard/_layout-input'

test('Essentials groups optional fields while preserving every financial field, action and column', () => {
  for (const kind of ['customer_invoice', 'vendor_bill', 'card_charge', 'check', 'expense_report', 'customer_payment', 'vendor_payment']) {
    const original = defaultFormLayout(kind)
    const snapshot = structuredClone(original)
    const compact = essentialsFormLayout(original)
    assert.ok(parseFormLayout(compact).success, kind)
    assert.deepEqual(original, snapshot, 'presentation must not mutate the source layout')
    assert.deepEqual(compact.header.groups.flatMap((group) => group.fields).map((field) => field.key).sort(), original.header.groups.flatMap((group) => group.fields).map((field) => field.key).sort())
    assert.ok(compact.header.groups.filter((group) => group.collapsible).every((group) => group.fields.every((field) => !field.required)))
    assert.deepEqual(compact.lines.columns.map(({ secondary: _secondary, ...column }) => column), original.lines.columns)
    assert.deepEqual(compact.actions, original.actions)
  }
  const journal = defaultFormLayout('journal')
  assert.equal(essentialsFormLayout(journal), journal, 'specialist defaults remain unchanged')
})

test('Essentials promotes daily navigation without losing specialist modules and uses valid dashboard widgets', () => {
  const compact = essentialsNavConfig()
  const keys = compact.groups.flatMap((group) => group.items.flatMap((item) => item.kind === 'module' ? [item.moduleKey] : []))
  const original = defaultNavConfig().groups.flatMap((group) => group.items.flatMap((item) => item.kind === 'module' ? [item.moduleKey] : []))
  assert.equal(new Set(keys).size, keys.length, 'no duplicate shortcuts')
  assert.deepEqual([...keys].sort(), original.filter((key) => !['ar', 'ap', 'banking'].includes(key)).sort())
  assert.deepEqual(keys.slice(0, 3), ['dashboard', 'ar-invoices', 'ap-bills'])
  const layout = essentialsDefaultLayout()
  assert.ok(DashboardLayoutInputSchema.safeParse(layout).success)
  assert.deepEqual(clampToWidgetMinimums(layout.widgets), layout.widgets)
  assert.ok(layout.quickActions?.some((action) => action.href.includes('kind=customer_invoice')))
})
