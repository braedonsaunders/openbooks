import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F-t04-003 (overlay path): the /entities + /parties loaders supply the
// vendor Compliance tab inputs, but the shell-level related-party overlay
// (GlobalPartyDrawerHost, used from every record page via ?relatedParty=)
// fetched /api/parties/[id]/drawer and rendered PartyDrawer WITHOUT the
// compliance props — so the tab never appeared no matter the feature state.
// The host must forward the drawer's compliance fields, and relatedPartyTab
// must admit 'compliance' like partyTab does.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/ap/bills?relatedParty=019f0000-0000-4000-8000-000000000003&relatedPartyRole=vendor',
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
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

Object.assign(globalThis, {
  __hostTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
  __hostTestQuery: 'relatedParty=019f0000-0000-4000-8000-000000000003&relatedPartyRole=vendor',
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__hostTestRouter}export function usePathname(){return "/ap/bills"}export function useSearchParams(){return new URLSearchParams(globalThis.__hostTestQuery ?? "")}',
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
const messages = (await import('../messages/en')).default
const { MoneyProvider } = await import('./money-provider')
const { GlobalPartyDrawerHost } = await import('./global-party-drawer-host')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const PARTY_ID = '019f0000-0000-4000-8000-000000000003'
const CLASSES = [
  { id: '11111111-1111-4111-8111-111111111111', code: 'SUB', name: 'Subcontractor' },
]

const drawerPayload = {
  payload: {
    party: { id: PARTY_ID, display_name: 'Fleet6 Test Vendor', kind: 'company', is_active: true },
    customer: null,
    vendor: {},
    employee: null,
    addresses: [],
    contacts: [],
    bankAccounts: [],
    transactionSummary: { count: 0, openCount: 0, lastDate: null, currencies: [] },
    additionalSubsidiaryIds: [],
  },
  paymentTerms: [],
  departments: [],
  trades: [],
  fieldDefs: [],
  subsidiaries: [],
  accounts: [],
  taxCodes: [],
  salesReps: [],
  layout: null,
  forms: [],
  currentFormId: null,
  recordType: 'vendor',
  canCustomize: false,
  payrollEnabled: false,
  multiCurrency: false,
  complianceEnabled: true,
  canManageCompliance: true,
  compliance: { classId: null, classes: CLASSES },
}

async function mountHost(t: TestContext): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    assert.ok(String(url).includes(`/api/parties/${PARTY_ID}/drawer`), `host must load the drawer payload, got ${String(url)}`)
    return Response.json(drawerPayload)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <GlobalPartyDrawerHost canManage={false} canReadActivities={false} canManageWages={false} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 10; i++) await tick()
  })
}

function findTab(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button[role="tab"]')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
}

test('the overlay vendor drawer forwards the Compliance tab (F-t04-003)', async (t) => {
  await mountHost(t)
  assert.ok(
    findTab('Compliance'),
    'an overlay vendor drawer must offer Compliance when the drawer payload carries it',
  )
})
