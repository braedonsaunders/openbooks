import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { approvalTabBody } from './approval-history'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
Object.assign(globalThis, { __approvalHistoryRouter: { push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} } })
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return globalThis.__approvalHistoryRouter}' }
    }
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}' }
    }
    return next(specifier, context)
  },
})
const { ApprovalHistory } = await import('./approval-history')

// the receipt Approvals tab rendered a completely blank panel —
// no spinner, no content, no empty state. The tab body is a four-state
// machine; the component must render something visible for every state.
test('approval tab body states: loading, history, pending, empty', () => {
  assert.equal(approvalTabBody(null), 'loading')
  assert.equal(
    approvalTabBody({ history: [{ id: 'run:1' }], approvalState: { pendingWith: [] } }),
    'history',
  )
  assert.equal(
    approvalTabBody({
      history: [],
      approvalState: { pendingWith: [{ name: 'Controller', gateId: 'g1', since: '2026-09-01' }] },
    }),
    'pending',
  )
  assert.equal(approvalTabBody({ history: [], approvalState: { pendingWith: [] } }), 'empty')
})

test('history wins over a concurrent pending gate', () => {
  assert.equal(
    approvalTabBody({
      history: [{ id: 'run:1' }],
      approvalState: { pendingWith: [{ name: 'Controller', gateId: 'g1', since: '2026-09-01' }] },
    }),
    'history',
  )
})

test('shared history component renders its empty body for a bank account subject', async (t: TestContext) => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    approvalState: { status: 'approved', pendingWith: [], myActions: null },
    history: [],
  })) as typeof fetch
  t.after(() => { globalThis.fetch = previousFetch })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ApprovalHistory subjectKind="party_bank_account" subjectId="bank-account-42" showEmptyState />
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  assert.equal(host.textContent, 'No approvals required for this record.')
})

// residual: a record whose status claims it awaits approval, but
// which no flow run ever fired for, is neither history nor genuinely empty —
// the tab must name the stale state instead of "No approvals required".
test('a pending record never sent to any flow resolves its own tab body', () => {
  assert.equal(
    approvalTabBody({
      history: [],
      approvalState: { pendingWith: [], status: 'pending' },
      neverSubmitted: true,
    }),
    'unsubmitted',
  )
  assert.equal(
    approvalTabBody({ history: [], approvalState: { pendingWith: [], status: 'pending' } }),
    'empty',
  )
})
