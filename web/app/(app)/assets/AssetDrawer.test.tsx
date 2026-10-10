import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// a required fixed-asset Category picker with no categories must name
// the prerequisite and link Asset Categories setup (setup managers only);
// readers without setup access must hear the grant instead of silence. A
// configured tenant must see no prerequisite at all.

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/assets?assetNew=1', scrollIntoView: false })

Object.assign(globalThis, {
  __assetTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__assetTestRouter}export function usePathname(){return "/assets"}export function useSearchParams(){return new URLSearchParams()}' })
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('../../../components/money-provider')
const { AssetDrawer } = await import('./AssetDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function payload() {
  return {
    asset: {
      id: '',
      category_id: '',
      subsidiary_id: '',
      asset_number: '',
      name: '',
      description: null,
      status: 'draft',
      acquired_on: null,
      in_service_on: null,
      acquisition_cost: '0.0000',
      salvage_value: '0.0000',
      serial_number: null,
      depreciation_method: null,
      depreciation_method_id: null,
      useful_life_months: null,
      depreciation_rate_percent: null,
      depreciation_convention: null,
      depreciation_units_total: null,
      opening_accumulated_depreciation: null,
      opening_accumulated_as_of: null,
      custom: {},
      updated_at: '',
      asset_account_id: null,
      accumulated_depreciation_account_id: null,
      depreciation_expense_account_id: null,
    },
    category: null,
    accounts: {
      assetAccountId: null,
      accumulatedDepreciationAccountId: null,
      depreciationExpenseAccountId: null,
    },
    accountNames: { asset: null, accumulated: null, expense: null },
    totals: {
      remainingCost: '0.0000',
      accumulated: '0.0000',
      netBookValue: '0.0000',
      posted: '0.0000',
      planned: '0.0000',
    },
    books: [],
    schedulePage: { total: 0, page: 1, perPage: 25, bookId: null, query: '' },
    hasAccountingEvidence: false,
    schedule: [],
  }
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    payload: payload(),
    categories: [],
    accounts: [],
    taxConfigurations: [],
    subsidiaries: [],
    canManage: true,
    canManageSetup: true,
    canCustomize: false,
    forms: [],
    currentFormId: null,
    fieldDefs: [],
    depreciationMethods: [],
    periods: [],
    closeHref: '/assets',
    createMode: true,
    ...overrides,
  }
}

async function mountDrawer(t: TestContext, props: Record<string, unknown>): Promise<void> {
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <AssetDrawer {...(props as unknown as React.ComponentProps<typeof AssetDrawer>)} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
}

test('empty categories name the prerequisite and link setup for managers', async (t) => {
  await mountDrawer(t, baseProps({ canManageSetup: true }))
  const body = document.body.textContent ?? ''
  assert.match(body, /No asset categories yet/, 'the drawer must name the missing prerequisite')
  const setupLink = document.querySelector('a[href="/admin/setup/asset-categories"]')
  assert.ok(setupLink, 'setup managers must get the Asset Categories link')
  assert.match(setupLink.textContent ?? '', /Set up asset categories/, 'the link must name its remedy')
})

test('readers without setup access hear the grant instead of a link', async (t) => {
  await mountDrawer(t, baseProps({ canManageSetup: false }))
  const body = document.body.textContent ?? ''
  assert.match(body, /No asset categories yet/, 'the prerequisite must still be named')
  assert.equal(
    document.querySelector('a[href="/admin/setup/asset-categories"]'),
    null,
    'readers without setup access must not get a setup link',
  )
  assert.match(body, /administrator with setup access/, 'the copy must name the grant needed')
})

test('a configured tenant sees no prerequisite', async (t) => {
  await mountDrawer(
    t,
    baseProps({ categories: [{ id: 'cat-1', name: 'Machinery' }] }),
  )
  const body = document.body.textContent ?? ''
  assert.doesNotMatch(body, /No asset categories yet/, 'configured tenants must see no prerequisite')
  assert.equal(
    document.querySelector('a[href="/admin/setup/asset-categories"]'),
    null,
    'configured tenants must see no setup link',
  )
})

const CATEGORY_ACCOUNTS = [
  { id: 'acct-1500', number: '1500', name: 'Equipment' },
  { id: 'acct-1510', number: '1510', name: 'Accumulated depreciation - equipment' },
  { id: 'acct-6600', number: '6600', name: 'Depreciation expense' },
  { id: 'acct-1520', number: '1520', name: 'Vehicles' },
  { id: 'acct-1530', number: '1530', name: 'Accumulated depreciation - vehicles' },
  { id: 'acct-6610', number: '6610', name: 'Vehicle depreciation' },
]
const EQUIPMENT = {
  id: 'cat-equipment', name: 'Equipment', asset_account_id: 'acct-1500',
  accumulated_depreciation_account_id: 'acct-1510', depreciation_expense_account_id: 'acct-6600',
  default_method: 'straight_line', default_depreciation_method_id: null, default_life_months: 60,
  default_convention: 'full_month', tax_attributes: {},
}
const VEHICLES = {
  id: 'cat-vehicles', name: 'Vehicles', asset_account_id: 'acct-1520',
  accumulated_depreciation_account_id: 'acct-1530', depreciation_expense_account_id: 'acct-6610',
  default_method: 'straight_line', default_depreciation_method_id: null, default_life_months: 36,
  default_convention: 'half_year', tax_attributes: {},
}

function listboxLabels(): string[] {
  return [...document.querySelectorAll('button[aria-haspopup="listbox"]')].map((button) => (button.textContent ?? '').trim())
}

async function chooseCategory(categoryId: string): Promise<void> {
  const select = [...document.querySelectorAll('select')].find((node) =>
    [...node.options].some((option) => option.value === categoryId))
  assert.ok(select, 'the category picker must render')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, categoryId)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
}

test('a new asset opens on its category accounts and follows a category change', async (t) => {
  const createPayload = { ...payload(), category: EQUIPMENT, asset: { ...payload().asset, category_id: EQUIPMENT.id } }
  await mountDrawer(t, baseProps({ payload: createPayload, categories: [EQUIPMENT, VEHICLES], accounts: CATEGORY_ACCOUNTS }))
  const opened = listboxLabels()
  for (const label of ['1500 Equipment', '1510 Accumulated depreciation - equipment', '6600 Depreciation expense']) {
    assert.ok(opened.includes(label), `the new asset must show ${label}; saw ${opened.join(' | ')}`)
  }
  assert.ok([...document.querySelectorAll('input')].some((input) => input.value === '60'), 'the category life must prefill')

  await chooseCategory(VEHICLES.id)
  const switched = listboxLabels()
  for (const label of ['1520 Vehicles', '1530 Accumulated depreciation - vehicles', '6610 Vehicle depreciation']) {
    assert.ok(switched.includes(label), `the new category must supply ${label}; saw ${switched.join(' | ')}`)
  }
  assert.ok([...document.querySelectorAll('input')].some((input) => input.value === '36'), 'the new category life must replace the old default')
})
