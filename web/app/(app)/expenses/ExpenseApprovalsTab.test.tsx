import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F-t04-002: the expense-report drawer Approvals tab rendered a completely
// blank panel (tab bar → totals footer, nothing between). The tab mounts the
// element below — the exact JSX ExpenseDrawer.tsx uses as its Approvals
// detailTab content. These tests render it under jsdom with a scripted
// record-state fetch and require visible content in every state.

// jsdom first: the approvals components read browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/expenses/reports',
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__expenseApprovalsTestRouter}export function usePathname(){return "/expenses/reports"}export function useSearchParams(){return new URLSearchParams()}',
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

const REPORT_ID = '019f0000-0000-4000-8000-000000000001'

// The exact JSX ExpenseDrawer.tsx mounts as its Approvals detailTab content
// (pinned by approval-history.test.ts). The pre-fix variant without
// showEmptyState renders a literal blank panel — the F-t04-002 mechanism,
// reproduced red below before this file required content.
const tabElement = (
  <ApprovalHistory subjectKind="expense_report" subjectId={REPORT_ID} showEmptyState />
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

test('expense Approvals tab renders loading content while record-state is in flight', async (t) => {
  const { host, urls } = await mountTab(
    t,
    (() => new Promise<Response>(() => {})) as typeof fetch,
  )
  assert.ok(
    urls.some((url) => url.includes('subjectKind=expense_report')),
    'the tab must query record-state for the expense report',
  )
  assert.match(
    host.textContent ?? '',
    /Loading…/,
    'F-t04-002: the Approvals tab body must render content even before the fetch resolves',
  )
})

test('expense Approvals tab renders the empty state when no flow history exists', async (t) => {
  const { host } = await mountTab(
    t,
    (async () => Response.json(EMPTY_STATE)) as typeof fetch,
  )
  assert.match(
    host.textContent ?? '',
    /No approvals required for this record\./,
    'F-t04-002: the Approvals tab body must render content, never a blank panel',
  )
})

test('expense Approvals tab renders the submitted/requested/approved chain', async (t) => {
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

// The F-t04-002 mechanism, pinned: the pre-fix tab JSX (no showEmptyState)
// renders a literal blank panel on empty history. If the drawer ever drops
// the opt-in, this documents exactly which blank returns.
test('pre-fix tab JSX without showEmptyState renders the reported blank panel', async (t) => {
  const prior = globalThis.fetch
  globalThis.fetch = (async () => Response.json(EMPTY_STATE)) as typeof fetch
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
        <ApprovalHistory subjectKind="expense_report" subjectId={REPORT_ID} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
  assert.equal(
    host.textContent ?? '',
    '',
    'without showEmptyState the empty-history tab is blank — the reported defect',
  )
})
