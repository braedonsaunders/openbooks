import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F2-3: a rate-lookup 422 silently cleared rate, amount, source and
// provenance with no message. The lookup now pins its named reason beside
// the kept (stale) values. Mounts the real FieldTicketDrawer under jsdom:
// a successful lookup prices the line, then a refused lookup must keep the
// last good rate on screen with the named reason in a role=alert region.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/field-tickets?ticket=ft-1&transactionTab=items',
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
  __ftTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__ftTestRouter}export function usePathname(){return "/field-tickets"}export function useSearchParams(){return new URLSearchParams("ticket=ft-1&transactionTab=items")}',
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
const { FieldTicketDrawer } = await import('./FieldTicketDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const TICKET = {
  id: 'ft-1',
  documentNumber: 'FT-0001',
  status: 'draft',
  documentDate: '2026-09-15',
  referenceNumber: null,
  memo: null,
  customerName: 'Acme',
  projectId: 'proj-1',
  projectName: 'Acme Tower',
  foremanName: 'Sammy Sloppy',
  revision: '2026-09-01T10:00:00.000000Z',
  fieldTicket: { period: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', foremanPartyId: null },
  entries: [],
  lines: [],
  laborTotal: '0',
  linesTotal: '0',
  grandTotal: '0',
  links: [],
  billingRequests: [],
}

async function mount(t: TestContext, rateResponder: () => Response): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/flows/manual')) return Response.json({ buttons: [] })
    if (url.startsWith('/api/flows/record-state')) {
      return Response.json({ approvalState: { status: 'draft', pendingWith: [], myActions: null }, history: [] })
    }
    if (url.startsWith('/api/field-tickets/item-rate')) return rateResponder()
    throw new Error(`unexpected fetch ${(init?.method ?? 'GET')} ${url}`)
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
          <FieldTicketDrawer
            ticket={TICKET as never}
            employees={[]}
            laborItems={[]}
            timeTypes={[]}
            catalogItems={[{ id: 'item-1', name: 'Excavation', kind: 'service', default_rate: null }]}
            projects={[{ id: 'proj-1', name: 'Acme Tower', customerName: 'Acme' } as never]}
            projectTasks={[]}
            equipmentUnits={[]}
            equipmentEnabled={false}
            canManage
            initialMode="edit"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 10; i++) await tick()
  })
}

async function pickItem(): Promise<void> {
  const trigger = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('Pick an item'),
  ) as HTMLButtonElement | undefined
  assert.ok(trigger, 'the line item picker must render')
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  const option = [...document.querySelectorAll('button[role="option"]')].find((candidate) =>
    (candidate.textContent ?? '').includes('Excavation'),
  ) as HTMLButtonElement | undefined
  assert.ok(option, 'the picker must offer the Excavation item')
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 10; i++) await tick()
  })
}

async function setQty(value: string): Promise<void> {
  const qty = document.querySelector('#ft-qty') as HTMLInputElement | null
  assert.ok(qty, 'the quantity input must render')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(qty, value)
    qty.dispatchEvent(new window.Event('input', { bubbles: true }))
    for (let i = 0; i < 10; i++) await tick()
  })
}

test('a refused rate lookup keeps the last good rate and pins the named reason', async (t) => {
  let refuse = false
  await mount(t, () =>
    refuse
      ? Response.json({ error: 'no rate book covers Excavation on 2026-09-30' }, { status: 422 })
      : Response.json({ rate: '150.00', amount: '150.00', source: 'rate_book', rateUnits: [] }),
  )
  await pickItem()
  await setQty('1')
  assert.ok(
    (document.querySelector('#ft-rate') as HTMLInputElement | null)?.value.includes('150'),
    'the successful lookup must price the line',
  )
  refuse = true
  await setQty('2')
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the refused lookup must pin its reason instead of failing silently')
  assert.match(alert.textContent ?? '', /no rate book covers Excavation/)
  assert.ok(
    (document.querySelector('#ft-rate') as HTMLInputElement | null)?.value.includes('150'),
    'the last good rate must stay on screen beside the refusal',
  )
})
