import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// UX-05: a required fixed-asset Category picker with no categories must name
// the prerequisite and link Asset Categories setup (setup managers only);
// readers without setup access must hear the grant instead of silence. A
// configured tenant must see no prerequisite at all.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/assets?assetNew=1',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

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
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__assetTestRouter}export function usePathname(){return "/assets"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
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

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
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
