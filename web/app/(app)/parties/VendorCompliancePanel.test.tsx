import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F-t04-003: the compliance-vendors matrix tells the user to "assign a
// compliance class on a vendor's Compliance tab", but the vendor drawer has
// no such tab — compliance tracking cannot be started. The vendor drawer
// must offer a Compliance tab (feature-gated) whose panel assigns the class
// through PATCH /api/compliance/vendors/[partyId] and brings the vendor
// into the matrix.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/entities/vendors',
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

const script = {
  toasts: [] as Array<{ kind: 'success' | 'error'; message: string }>,
}
Object.assign(globalThis, {
  __vendorComplianceTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__vendorComplianceTestRouter}export function usePathname(){return "/entities/vendors"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(message){globalThis.__vendorComplianceTestToasts.push({kind:"success",message})},error(message){globalThis.__vendorComplianceTestToasts.push({kind:"error",message})}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React, __vendorComplianceTestToasts: script.toasts })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('../../../components/money-provider')
const { VendorCompliancePanel } = await import('./VendorCompliancePanel')
const { PartyDrawer } = await import('./PartyDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const PARTY_ID = '019f0000-0000-4000-8000-000000000003'
const CLASSES = [
  { id: '11111111-1111-4111-8111-111111111111', code: 'SUB', name: 'Subcontractor' },
  { id: '22222222-2222-4222-8222-222222222222', code: 'SUP', name: 'Supplier' },
]

interface RequestLog {
  url: string
  method: string
  body?: unknown
}

async function mountPanel(
  t: TestContext,
  args: { initialClassId: string | null; canManage: boolean },
): Promise<{ requests: RequestLog[] }> {
  const requests: RequestLog[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined
    requests.push({ url: String(url), method, body })
    return Response.json({ partyId: PARTY_ID })
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
  script.toasts.length = 0
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <VendorCompliancePanel
            partyId={PARTY_ID}
            initialClassId={args.initialClassId}
            classes={CLASSES}
            canManage={args.canManage}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { requests }
}

function findByText(text: string): Element | undefined {
  return [...document.querySelectorAll('p, h3, span, a, button, label')].find((el) =>
    (el.textContent ?? '').trim() === text,
  )
}

test('the panel names the untracked state when no class is assigned', async (t) => {
  await mountPanel(t, { initialClassId: null, canManage: true })
  const select = document.querySelector('select')
  assert.ok(select, 'a manager must get the compliance-class picker')
  assert.equal(select.value, '', 'no class is pre-selected for an untracked vendor')
  assert.ok(
    findByText('Assign a class to bring this vendor into the compliance matrix.'),
    'the untracked hint must name the path into the matrix',
  )
})

test('the panel pre-selects the assigned class', async (t) => {
  await mountPanel(t, { initialClassId: CLASSES[0]!.id, canManage: true })
  const select = document.querySelector('select')
  assert.ok(select, 'a manager must get the compliance-class picker')
  assert.equal(select.value, CLASSES[0]!.id, 'the assigned class must be pre-selected')
})

test('saving assigns the class through the compliance vendor route', async (t) => {
  const { requests } = await mountPanel(t, { initialClassId: null, canManage: true })
  const select = document.querySelector('select')
  assert.ok(select, 'a manager must get the compliance-class picker')
  await act(async () => {
    select.value = CLASSES[0]!.id
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  const save = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Save')
  assert.ok(save, 'a manager must get a Save action')
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  const patch = requests.find((r) => r.url === `/api/compliance/vendors/${PARTY_ID}` && r.method === 'PATCH')
  assert.deepEqual(
    patch?.body,
    { complianceClassId: CLASSES[0]!.id },
    'Save must assign the picked class through the compliance vendor route',
  )
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success'),
    'a successful assignment must confirm',
  )
})

/** A vendor drawer mount needs only a party shell — every tab but the selected one stays unmounted. */
async function mountPartyDrawer(
  t: TestContext,
  args: { role: 'vendor' | 'customer'; complianceEnabled: boolean },
): Promise<void> {
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
  const payload = {
    party: { id: PARTY_ID, display_name: 'Fleet6 Test Vendor', kind: 'company', is_active: true },
    customer: null,
    vendor: {},
    employee: null,
    addresses: [],
    contacts: [],
    bankAccounts: [],
    transactionSummary: { count: 0, openCount: 0, lastDate: null, currencies: [] },
    additionalSubsidiaryIds: [],
  } as never
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <PartyDrawer
            payload={payload}
            paymentTerms={[]}
            departments={[]}
            trades={[]}
            fieldDefs={[]}
            subsidiaries={[]}
            canManage={false}
            role={args.role}
            basePath="/entities/vendors"
            recordType={args.role}
            complianceEnabled={args.complianceEnabled}
            canManageCompliance
            compliance={{ classId: null, classes: CLASSES }}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
}

function findTab(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button[role="tab"]')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
}

test('the vendor drawer offers the Compliance tab when the feature is on', async (t) => {
  await mountPartyDrawer(t, { role: 'vendor', complianceEnabled: true })
  const tab = findTab('Compliance')
  assert.ok(tab, 'a vendor drawer must offer the Compliance tab the matrix points at')
  await act(async () => {
    tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    // The tab body swaps through AnimatePresence mode="wait" (~180ms exit
    // before the new panel mounts), so wait out the motion in jsdom.
    for (let i = 0; i < 12; i++) await tick()
  })
  assert.ok(
    findByText('Subcontractor compliance'),
    'the Compliance tab must render the class-assignment panel',
  )
  assert.ok(document.querySelector('select'), 'the panel must offer the class picker')
})

test('the vendor drawer hides the Compliance tab when the feature is off', async (t) => {
  await mountPartyDrawer(t, { role: 'vendor', complianceEnabled: false })
  assert.equal(findTab('Compliance'), undefined, 'no feature, no tab')
})

test('a customer drawer never offers the Compliance tab', async (t) => {
  await mountPartyDrawer(t, { role: 'customer', complianceEnabled: true })
  assert.equal(findTab('Compliance'), undefined, 'the tab is vendor-only')
})

test('the panel is read-only without the manage permission', async (t) => {
  const { requests } = await mountPanel(t, { initialClassId: CLASSES[0]!.id, canManage: false })
  assert.equal(document.querySelector('select'), null, 'a viewer must not get the class picker')
  assert.equal(document.querySelector('button'), null, 'a viewer must not get a Save action')
  assert.ok(findByText('SUB — Subcontractor'), 'a viewer must still see the assigned class')
  assert.ok(
    !requests.some((r) => r.method === 'PATCH'),
    'a read-only panel must never write',
  )
})
