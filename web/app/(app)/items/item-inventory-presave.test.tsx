import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/items?item=new' })

stubModules({
  navigation: {
    source:
      'export function useRouter() { return globalThis.__itemPresaveRouter }' +
      'export function usePathname() { return "/items" }' +
      'export function useSearchParams() { return new URLSearchParams("item=new") }',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next-intl': 'const t = (key) => key; export function useTranslations() { return t } export function useLocale() { return "en" }',
    sonner:
      'export const toast = { success(m) { globalThis.__itemPresaveToasts.push(String(m)) }, error(m) { globalThis.__itemPresaveToasts.push(String(m)) } }',
  },
})

const React = await import('react')
Object.assign(globalThis, {
  React,
  __itemPresaveToasts: [] as string[],
  __itemPresaveRouter: { push() {}, replace() {}, refresh() {}, back() {} },
})
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MoneyProvider } = await import('../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { ItemDrawer } = await import('./ItemDrawer.tsx')
const { defaultFormLayout } = await import('@openbooks/customization')

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const payload = {
  item: {
    id: '',
    kind: 'service',
    code: null,
    name: '',
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
    unit: null,
    description: null,
    show_on_timesheet: false,
    is_active: true,
    create_plans_on: 'billing',
    revenue_allocation: 'normal',
    custom: {},
    weight: null,
    weight_unit: null,
    dimensions: null,
    hs_code: null,
    country_of_origin: null,
  },
}

// A new item's Inventory tab cannot configure costing before the first
// save: it names the prerequisite instead of rendering an empty panel.
test('a pre-save Inventory tab explains the save prerequisite', async (t: TestContext) => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({})) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })
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
      inventoryCosting: true,
      createMode: true,
    }))))
    await tick()
  })
  const kindCard = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('kinds.inventory'))
  assert.ok(kindCard, 'the inventory kind card is offered')
  await act(async () => { kindCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
  const tab = [...document.querySelectorAll('button[aria-pressed]')].find((candidate) => candidate.textContent?.trim() === 'drawer.tabs.costing')
  assert.ok(tab, 'the Inventory tab is offered before the first save')
  await act(async () => { tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
  assert.ok(
    document.body.textContent?.includes('costingPresave.title'),
    'the pre-save Inventory tab names the save prerequisite instead of an empty panel',
  )
  assert.ok(document.body.textContent?.includes('costingPresave.hint'), 'the prerequisite carries its hint')
})
