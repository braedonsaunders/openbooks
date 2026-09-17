import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F-t04-016: an approved PO's drawer Approvals tab rendered a completely
// blank panel (tab bar → totals footer, nothing between). The tab mounts
// the element below — the exact JSX OrderDrawer.tsx uses as its Approvals
// detailTab content. These tests render it under jsdom with a scripted
// record-state fetch and require visible content in every state.

// jsdom first: the approvals components read browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/purchase-orders',
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

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__orderApprovalsTestRouter}export function usePathname(){return "/purchase-orders"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}',
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
const { ApprovalHistory } = await import('../../../components/approval-history')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const ORDER_ID = '01a0acda-76ce-7d6e-9886-01d36706de53'

// The exact JSX OrderDrawer.tsx mounts as its Approvals detailTab content.
const tabElement = (
  <ApprovalHistory subjectKind="purchase_order" subjectId={ORDER_ID} showEmptyState />
)

const EMPTY_STATE = {
  approvalState: { status: 'approved', pendingWith: [], myActions: null },
  history: [],
}

async function mountTab(
  t: TestContext,
  fetchImpl: typeof fetch,
): Promise<{ host: HTMLElement; urls: string[] }> {
  const prior = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    urls.push(String(input))
    return fetchImpl(input as RequestInfo | URL, init)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {tabElement}
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
  return { host, urls }
}

test('PO Approvals tab renders loading content while record-state is in flight', async (t) => {
  const { host, urls } = await mountTab(
    t,
    (() => new Promise<Response>(() => {})) as typeof fetch,
  )
  assert.ok(
    urls.some((url) => url.includes('subjectKind=purchase_order')),
    'the tab must query record-state for the purchase order',
  )
  assert.match(
    host.textContent ?? '',
    /Loading…/,
    'F-t04-016: the Approvals tab body must render content even before the fetch resolves',
  )
})

test('PO Approvals tab renders the empty state when no flow history exists', async (t) => {
  const { host } = await mountTab(
    t,
    (async () => Response.json(EMPTY_STATE)) as typeof fetch,
  )
  assert.match(
    host.textContent ?? '',
    /No approvals required for this record\./,
    'F-t04-016: the Approvals tab body must render content, never a blank panel',
  )
})

test('PO Approvals tab renders the submitted/requested/approved chain', async (t) => {
  const chain = {
    approvalState: { status: 'approved', pendingWith: [], myActions: null },
    history: [
      { id: 'run:1', type: 'submitted', actor: 'Sammy Sloppy', comment: null, at: '2026-09-01T10:00:00.000Z' },
      { id: 'gate:g1:requested', type: 'requested', actor: 'Controller', comment: null, at: '2026-09-01T10:01:00.000Z', title: 'Manager approval' },
      { id: 'gate:g1:decided', type: 'approved', actor: 'Casey Controller', comment: null, at: '2026-09-02T10:00:00.000Z', title: 'Manager approval' },
    ],
  }
  const { host } = await mountTab(
    t,
    (async () => Response.json(chain)) as typeof fetch,
  )
  const text = host.textContent ?? ''
  assert.match(text, /Submitted for approval/, 'the submitter event must render')
  assert.match(text, /Sammy Sloppy/, 'the submitter name must render')
  assert.match(text, /Approval requested/, 'the gate request must render')
  assert.match(text, /Approved/, 'the decision must render')
  assert.match(text, /Manager approval/, 'the gate title must render')
})
