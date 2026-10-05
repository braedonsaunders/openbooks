import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/items?item=new' })

stubModules({
  navigation: {
    source:
      'export function useRouter() { return globalThis.__itemDrawerRouter }' +
      'export function usePathname() { return "/items" }' +
      'export function useSearchParams() { return new URLSearchParams("item=new") }',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next-intl': 'const t = (key) => key; export function useTranslations() { return t } export function useLocale() { return "en" }',
    sonner:
      'export const toast = { success(m) { globalThis.__itemDrawerToasts.push(String(m)) }, error(m) { globalThis.__itemDrawerToasts.push(String(m)) } }',
  },
})

const React = await import('react')
Object.assign(globalThis, {
  React,
  __itemDrawerToasts: [] as string[],
  __itemDrawerRouter: { push() {}, replace() {}, refresh() {}, back() {} },
})
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MoneyProvider } = await import('../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { ItemDrawer } = await import('./ItemDrawer.tsx')
const { defaultFormLayout } = await import('@openbooks/customization')

const item = {
  id: 'item-new',
  kind: 'service',
  code: '',
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
  unit: '',
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

async function mountCreate(t: TestContext, props: Record<string, unknown> = {}) {
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
      createMode: true,
      ...props,
    }))))
    await tick()
  })
}

async function clickCard(fragment: string) {
  const card = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(fragment))
  assert.ok(card, `a card mentioning ${fragment} is rendered`)
  await act(async () => { card.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  assert.ok(button, `button ${label} is rendered`)
  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
}

test('a sellable kind offers single versus variants after the kind cards', async (t) => {
  await mountCreate(t, { variantsEnabled: true })
  assert.ok(document.body.textContent?.includes('kinds.service'), 'the kind cards render first')
  await clickCard('kinds.service')
  const body = document.body.textContent ?? ''
  assert.ok(body.includes('structure.singleTitle') && body.includes('structure.familyTitle'), 'the structure choice follows the kind')
})

test('without the gate the create flow is unchanged', async (t) => {
  await mountCreate(t, { variantsEnabled: false })
  await clickCard('kinds.service')
  const body = document.body.textContent ?? ''
  assert.ok(!body.includes('structure.familyTitle'), 'no structure step without the gate')
  assert.ok(body.includes('drawer.tabs.overview'), 'the form opens directly')
})

test('choosing variants continues to options with a live count', async (t) => {
  await mountCreate(t, { variantsEnabled: true })
  await clickCard('kinds.service')
  await clickCard('structure.familyTitle')
  assert.ok(document.body.textContent?.includes('detailsTitle'), 'the family details step opens in the same drawer')
  const name = document.querySelectorAll('input')[0] as HTMLInputElement | undefined
  assert.ok(name, 'the family name is editable')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(name, 'Classic Tee')
    name.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  await clickButton('continue')
  const body = document.body.textContent ?? ''
  assert.ok(body.includes('optionsTitle'), 'the options step follows details')
  assert.ok(body.includes('variantCount'), 'the live variant count is shown')
})
