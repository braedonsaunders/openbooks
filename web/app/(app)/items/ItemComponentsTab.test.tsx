import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/items?item=kit-1&itemSetup=components' })

stubModules({
  navigation: {
    source:
      'export function useRouter() { return globalThis.__slotRouter }' +
      'export function usePathname() { return "/items" }' +
      'export function useSearchParams() { return new URLSearchParams("item=kit-1&itemSetup=components") }',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next-intl': 'const t = (key) => key; export function useTranslations() { return t } export function useLocale() { return "en" }',
    sonner:
      'export const toast = { success() {}, error() {} }',
  },
})

const React = await import('react')
Object.assign(globalThis, {
  React,
  __slotRouter: { push() {}, replace() {}, refresh() {}, back() {} },
})
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MoneyProvider } = await import('../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { ItemDrawer } = await import('./ItemDrawer.tsx')
const { KitComponentsTab } = await import('./KitComponentsTab.tsx')
const { defaultFormLayout } = await import('@openbooks/customization')

const item = {
  id: 'kit-1',
  kind: 'kit',
  code: 'KIT-1',
  name: 'Test kit',
  category: null,
  income_account_id: null,
  expense_account_id: null,
  payroll_expense_account_id: null,
  deferred_account_id: null,
  cost_recovery_account_id: null,
  tax_code_id: null,
  recognition_rule_id: null,
  default_rate: null,
  default_cost: null,
  standalone_selling_price: null,
  unit: 'each',
  description: '',
  show_on_timesheet: false,
  is_active: true,
  create_plans_on: 'billing',
  revenue_allocation: 'normal',
  weight: null,
  weight_unit: null,
  dimensions: null,
  hs_code: null,
  country_of_origin: null,
  custom: {},
}
const payload = { item, incomeAccountName: null, expenseAccountName: null, payrollCostingAccountName: null, taxCodeName: null }
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

// Adjacent effectivity windows over one component, mirroring the seeded kit.
const bomBody = {
  assemblyItemId: 'kit-1',
  version: 'v1',
  components: [
    {
      id: 'line-1', componentItemId: 'comp-a', quantityPer: '2', effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30', code: 'COMP-A', name: 'Component A', isActive: true,
      joinedId: 'comp-a', isCurrent: false,
    },
    {
      id: 'line-2', componentItemId: 'comp-a', quantityPer: '3', effectiveFrom: '2026-07-01',
      effectiveTo: null, code: 'COMP-A', name: 'Component A', isActive: true,
      joinedId: 'comp-a', isCurrent: true,
    },
  ],
  validItems: [],
}

test('kit components inside the item drawer render without a key warning', async (t: TestContext) => {
  const errors: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => { errors.push(String(args[0])) }
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/inventory/bom')) return Response.json(bomBody)
    return Response.json({ item })
  }) as typeof fetch
  t.after(() => {
    console.error = orig
    globalThis.fetch = priorFetch
  })
  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    root.render(React.createElement(MoneyProvider as React.ComponentType<{ currency: string }>, { currency: 'USD' }, React.createElement(BusinessDateProvider as React.ComponentType<{ today: string }>, { today: '2026-09-24' }, React.createElement(ItemDrawer, {
      payload,
      accounts: [],
      taxCodes: [],
      fieldDefs: [],
      layout: defaultFormLayout('item'),
      canManage: true,
      recordTabs: [
        {
          key: 'components',
          label: 'Components',
          content: React.createElement(KitComponentsTab, {
            itemId: 'kit-1',
            itemLabel: 'KIT-1 · Test kit',
            canManage: true,
            tabHref: '/items?item=kit-1&itemSetup=components',
            editing: false,
          }),
        },
      ],
    }))))
    await tick()
    await tick()
    await tick()
  })
  assert.ok(document.body.textContent?.includes('Component A'), 'recipe rows render')
  assert.deepEqual(errors.filter((e) => e.includes('unique "key"')), [])
})
