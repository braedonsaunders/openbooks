import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../../testing/jsdom-env'
import { stubModules } from '../../../../../testing/stub-modules'

await bootJsdomEnvironment({ matchMediaMatches: false })
stubModules({ navigation: true })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { PspDisputeReviewDrawer } = await import('./ReviewDrawer')

const strings = {
  kindRow: 'Kind', statusRow: 'Status', amountRow: 'Amount', eventRow: 'Event',
  providerRefRow: 'Provider reference', reasonGivenRow: 'Reason', receiptRow: 'Receipt',
  invoiceRow: 'Invoice', historyTitle: 'History', approveLabel: 'Approve', rejectLabel: 'Reject',
  reasonLabel: 'Reason for rejection', reasonPlaceholder: 'Enter at least five characters',
  decidedNote: 'This review is resolved; the queue keeps it for the record.',
  approvedMessage: 'Review approved and posted.', rejectedMessage: 'The review could not be resolved.',
  closeLabel: 'Close',
}

test('a successful rejection reports resolution instead of the failure fallback', async (t) => {
  const priorFetch = globalThis.fetch
  let posted: Record<string, unknown> | null = null
  globalThis.fetch = async (_input, init) => {
    posted = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ ok: true })
  }
  t.after(() => { globalThis.fetch = priorFetch })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <PspDisputeReviewDrawer review={{
      id: 'dispute-1', providerLabel: 'Card processor', kindLabel: 'Dispute', statusLabel: 'Pending',
      isPending: true, amount: '$80.00', providerEventId: 'evt-1', providerRef: null,
      reason: null, receiptNumber: null, invoiceNumber: null, history: [], canDecide: true,
      closeHref: '/banking/psp-settlements/reviews', strings,
    }} />
  </NextIntlClientProvider>))

  const reason = document.getElementById('psp-review-reason') as HTMLInputElement
  assert.ok(reason)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(reason, 'Evidence does not match')
    reason.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const reject = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === strings.rejectLabel)
  assert.ok(reject)
  await act(async () => { reject.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })

  assert.deepEqual(posted, { action: 'reject', disputeId: 'dispute-1', reason: 'Evidence does not match' })
  assert.ok(document.body.textContent?.includes(strings.decidedNote))
  assert.ok(!document.body.textContent?.includes(strings.rejectedMessage))
  assert.equal(document.querySelector('[role="alert"]'), null)
})
