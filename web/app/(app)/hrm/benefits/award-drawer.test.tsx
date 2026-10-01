import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import React from 'react'
import { registerHooks } from 'node:module'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/hrm/benefits', scrollIntoView: false, resizeObserver: false, event: 'jsdom' })
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
stubModules({ navigation: 'export function useRouter(){return {push(){},refresh(){}}}' })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') return { shortCircuit: true, url: 'data:text/javascript,export const toast={error(message){globalThis.__benefitAwardErrors.push(message)}}' }
    return next(specifier, context)
  },
})
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const { AwardDrawer } = await import('./AwardDrawer')
const messages = Object.fromEntries(['hrm', 'common', 'ui'].map((name) => [name, JSON.parse(readFileSync(new URL(`../../../../messages/en/${name}.json`, import.meta.url), 'utf8'))]))
const drawer = { award: {
  id: 'award', programName: 'Recognition', programCode: 'THANKS', valueLabel: '$25.00', recipientLabel: 'Ada',
  periodFrom: '2026-01-01', periodTo: '2026-01-31', status: 'approved', statusLabel: 'Approved', currency: 'USD',
  programDeliveryMethod: 'payroll', externalRef: null, voidReason: null,
}, timelineEmpty: 'History retained.' } as never

async function render(canQueue: boolean, fetcher: typeof fetch) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const previous = globalThis.fetch
  globalThis.fetch = fetcher
  ;(globalThis as Record<string, unknown>).__benefitAwardErrors = []
  await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={messages}><AwardDrawer drawer={drawer} closeHref="/hrm/benefits" canManage canQueue={canQueue} /></NextIntlClientProvider>) })
  return { cleanup: async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previous } }
}

test('HR-only award manager has no payout action and performs no pay-run lookup', async () => {
  let calls = 0
  const ui = await render(false, (async () => { calls++; throw new Error('No finance lookup expected') }) as typeof fetch)
  try {
    assert.ok(!document.body.textContent?.includes('Queue for payout'))
    assert.equal(calls, 0)
  } finally { await ui.cleanup() }
})

test('finance selects an editable scoped native run and the server refusal preserves the drawer shell', async () => {
  const writes: Record<string, unknown>[] = []
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/payroll/runs') return Response.json({ runs: [
      { document_id: 'open-run', document_number: 'PAY-101', document_status: 'draft', run_status: 'draft', currency: 'USD', pay_date: '2026-02-01' },
      { document_id: 'posted-run', document_number: 'PAY-099', document_status: 'posted', run_status: 'committed', currency: 'USD' },
      { document_id: 'other-currency', document_number: 'PAY-102', document_status: 'draft', run_status: 'draft', currency: 'EUR' },
    ] })
    writes.push(JSON.parse(String(init?.body)))
    return Response.json({ error: 'Choose a pay run whose pay date is on or after the award payable date.' }, { status: 422 })
  }) as typeof fetch
  const ui = await render(true, fetcher)
  try {
    const shell = document.querySelector('[role="dialog"]')
    assert.ok(shell)
    const findQueue = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Queue for payout')!
    await act(async () => findQueue().click())
    const select = document.querySelector('select') as HTMLSelectElement
    assert.ok(select)
    assert.deepEqual(Array.from(select.options).map((option) => option.value), ['', 'open-run'])
    await act(async () => { select.value = 'open-run'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => findQueue().click())
    assert.deepEqual(writes, [{ action: 'queue', payRunDocumentId: 'open-run' }])
    assert.equal(document.querySelector('[role="dialog"]'), shell)
    assert.deepEqual((globalThis as Record<string, unknown>).__benefitAwardErrors, ['Choose a pay run whose pay date is on or after the award payable date.'])
  } finally { await ui.cleanup() }
})
