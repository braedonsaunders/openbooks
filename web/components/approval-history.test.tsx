import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { approvalTabBody } from './approval-history'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
Object.assign(globalThis, { __approvalHistoryRouter: { push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} } })
const { registerHooks } = await import('node:module')
await bootJsdomEnvironment({ html: "<!doctype html><html><body></body></html>", url: "http://localhost/" });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__approvalHistoryRouter}' }, intl: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
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

// A receipt with Flows off answers an empty approval state (never a
// refusal code): the Approvals tab renders its empty body for drafts and
// posted records alike instead of the raw "not_found" the QA build showed.
for (const status of ['draft', 'posted']) {
  test(`a ${status} customer payment with Flows off renders the empty approvals body`, async (t: TestContext) => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      approvalState: { status, pendingWith: [], myActions: null },
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
          <ApprovalHistory subjectKind="customer_payment" subjectId="receipt-8" showEmptyState />
        </NextIntlClientProvider>,
      )
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    assert.equal(host.textContent, 'No approvals required for this record.')
  })
}

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
