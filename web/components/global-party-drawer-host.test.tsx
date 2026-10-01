import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// (overlay path): the /entities + /parties loaders supply the
// vendor Compliance tab inputs, but the shell-level related-party overlay
// (GlobalPartyDrawerHost, used from every record page via ?relatedParty=)
// fetched /api/parties/[id]/drawer and rendered PartyDrawer WITHOUT the
// compliance props — so the tab never appeared no matter the feature state.
// The host must forward the drawer's compliance fields, and relatedPartyTab
// must admit 'compliance' like partyTab does.
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
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills?relatedParty=019f0000-0000-4000-8000-000000000003&relatedPartyRole=vendor", matchMediaMatches: false });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__hostTestRouter}export function usePathname(){return "/ap/bills"}export function useSearchParams(){return new URLSearchParams(globalThis.__hostTestQuery ?? "")}' }, intl: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
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
    party: { id: PARTY_ID, display_name: 'Test Vendor', kind: 'company', is_active: true },
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

async function mountHost(t: TestContext, requests: string[] = []): Promise<() => Promise<void>> {
  const prior = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    requests.push(String(url))
    if (String(url).includes("/transaction-drawer")) return Response.json(null)
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
  const render = async () => { await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <GlobalPartyDrawerHost canManage={false} canReadActivities={false} canManageWages={false} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 10; i++) await tick()
  }) }
  await render()
  return render
}

function findTab(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button[aria-pressed]')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
}

test('the overlay vendor drawer forwards the Compliance tab', async (t) => {
  await mountHost(t)
  assert.ok(
    findTab('Compliance'),
    'an overlay vendor drawer must offer Compliance when the drawer payload carries it',
  )
})


test('party and nested transaction requests survive unrelated URL changes', async (t) => {
  const requests: string[] = []
  const original = 'relatedParty=' + PARTY_ID + '&relatedPartyRole=vendor'
  Object.assign(globalThis, { __hostTestQuery: original })
  t.after(() => Object.assign(globalThis, { __hostTestQuery: original }))
  const render = await mountHost(t, requests)
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog)
  const nested = original + '&partyTxn=019f0000-0000-4000-8000-000000000004&partyTxnKind=vendor_bill'
  Object.assign(globalThis, { __hostTestQuery: nested })
  await render()
  Object.assign(globalThis, { __hostTestQuery: nested + '&relatedPartyTab=compliance&transactionTab=lines' })
  await render()
  assert.equal(document.querySelector('[role="dialog"]'), dialog, 'an unchanged party keeps its native dialog')
  assert.equal(requests.filter((url) => url.includes('/drawer?')).length, 1)
  assert.equal(requests.filter((url) => url.includes('/transaction-drawer')).length, 1)
})
