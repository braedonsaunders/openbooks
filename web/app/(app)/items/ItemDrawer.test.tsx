import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test, { type TestContext } from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/items?item=item-1' })
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'self']) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    ;(globalThis as Record<string, unknown>)[key] = domWindow[key]
  }
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: true, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const virtual = (source: string) => ({ shortCircuit: true as const, url: `data:text/javascript,${encodeURIComponent(source)}` })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl') return virtual('export function useTranslations() { return (key) => key } export function useLocale() { return "en" }')
    if (specifier === 'next/navigation') return virtual('export function useRouter() { return globalThis.__itemDrawerRouter } export function usePathname() { return "/items" } export function useSearchParams() { return new URLSearchParams("item=item-1") }')
    if (specifier === 'sonner') return virtual('export const toast = { success(m) { globalThis.__itemDrawerToasts.push(String(m)) }, error(m) { globalThis.__itemDrawerToasts.push(String(m)) } }')
    if (specifier === './FairValuePricesEditor') return virtual('export function FairValuePricesEditor() { return null }')
    return next(specifier, context)
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
const { ItemDrawer } = await import('./ItemDrawer.tsx')
const { defaultFormLayout } = await import('@openbooks/customization')

const item = {
  id: 'item-1',
  kind: 'service',
  code: 'SVC-1',
  name: 'Monthly advisory',
  category: null,
  income_account_id: null,
  expense_account_id: null,
  payroll_expense_account_id: null,
  deferred_account_id: null,
  cost_recovery_account_id: null,
  tax_code_id: null,
  recognition_rule_id: null,
  default_rate: '1.2345',
  default_cost: '9.8765',
  standalone_selling_price: '12.3400',
  unit: 'hour',
  description: 'Existing description',
  show_on_timesheet: false,
  is_active: true,
  create_plans_on: 'billing',
  revenue_allocation: 'normal',
  custom: {},
}
const payload = { item, incomeAccountName: null, expenseAccountName: null, payrollCostingAccountName: null, taxCodeName: null }
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

async function mountDrawer(t: TestContext, props: Record<string, unknown> = {}) {
  const priorFetch = globalThis.fetch
  const requests: Array<{ method: string; body?: Record<string, unknown> }> = []
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? 'GET',
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    })
    return Response.json({ item })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })
  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    root.render(React.createElement(ItemDrawer, {
      payload,
      accounts: [],
      taxCodes: [],
      fieldDefs: [],
      layout: defaultFormLayout('item'),
      canManage: true,
      fairValuePrices: true,
      ...props,
    }))
    await tick()
  })
  return requests
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  assert.ok(button, `button ${label} is rendered`)
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  return button
}

async function clickTab(key: string) {
  const tab = [...document.querySelectorAll('button[role="tab"]')].find((candidate) => candidate.textContent?.trim() === `drawer.tabs.${key}`)
  assert.ok(tab, `the ${key} tab is rendered`)
  await act(async () => tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
}

test('an unrelated item edit preserves exact decimal text in all pricing fields', async (t) => {
  const requests = await mountDrawer(t, { initialPricingView: 'simple', configuredPricingViews: ['simple'] })
  await clickButton('actions.edit')
  await clickTab('pricing')

  const pricingAmounts = [...document.querySelectorAll('input[inputmode="decimal"]')] as HTMLInputElement[]
  assert.deepEqual(pricingAmounts.map((input) => input.value), ['1.2345', '9.8765'], document.body.textContent)
  await clickTab('revenue')
  const sellingPrice = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null
  assert.ok(sellingPrice)
  assert.equal(sellingPrice.value, '12.3400')

  await clickTab('overview')
  const description = [...document.querySelectorAll('input')].find((input) => input.value === 'Existing description') as HTMLInputElement | undefined
  assert.ok(description, 'the unrelated description remains editable')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(description, 'Updated description only')
    description.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await clickButton('actions.save')

  const save = requests.find((request) => request.method === 'PATCH')
  assert.ok(save, 'the edited item is saved')
  assert.equal(save.body?.description, 'Updated description only')
  assert.equal(save.body?.defaultRate, '1.2345')
  assert.equal(save.body?.defaultCost, '9.8765')
  assert.equal(save.body?.standaloneSellingPrice, '12.3400')
})

test('a read-only pricing chooser exposes all modes and disables unconfigured changes', async (t) => {
  await mountDrawer(t, { canManage: false, initialPricingView: 'landing', configuredPricingViews: ['matrix'] })
  await clickTab('pricing')
  const buttons = [...document.querySelectorAll('button')]
  const modeButton = (key: string) => buttons.find((button) => button.textContent?.includes(`pricingModes.${key}Title`))
  for (const key of ['simple', 'matrix', 'customer', 'cost', 'rules', 'contract', 'subscription']) {
    assert.ok(modeButton(key), `the ${key} pricing mode is available in the chooser`)
  }
  assert.equal(modeButton('simple')?.disabled, true, 'read-only users cannot switch to an unconfigured mode')
  assert.equal(modeButton('matrix')?.disabled, false, 'an existing pricing mode remains readable')
})

test('a persisted simple-pricing mode opens its editor and returns to the chooser', async (t) => {
  await mountDrawer(t, { canManage: false, initialPricingView: 'simple', configuredPricingViews: ['simple'] })
  await clickTab('pricing')
  assert.ok(document.body.textContent?.includes('labels.defaultRate'))
  assert.ok(document.body.textContent?.includes('labels.defaultCost'))
  assert.ok(document.body.textContent?.includes('1.2345'))
  assert.ok(document.body.textContent?.includes('9.8765'))
  await clickButton('pricingModes.back')
  assert.ok(document.body.textContent?.includes('pricingModes.title'), 'the pricing mode chooser is reachable again')
})
