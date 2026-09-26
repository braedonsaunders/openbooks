import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/analytics', matchMediaMatches: false, scrollIntoView: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: { pathname: '/analytics' } })

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { CashWeekFlyout } = await import('./CashWeekFlyout')

test('cash week entry failures offer retry and pagination controls have translated names', async (t) => {
  const entries = Array.from({ length: 26 }, (_, index) => ({ id: `entry-${index}`, entryId: `entry-${index}`, docKind: 'vendor_bill', docNumber: `B-${index}`, docId: `doc-${index}`, partyId: `party-${index}`, partyName: `Vendor ${index}`, amount: '10.0000', tranDate: '2026-08-01', dueDate: null, predictedDate: '2026-08-03', weekStart: '2026-08-02', daysOverdue: 0, method: 'manual' }))
  const week = {
    weekStart: '2026-08-02', weekEnd: '2026-08-08', label: 'Aug 2–8', inflow: '0.0000', outflow: '260.0000', net: '-260.0000',
    startingCash: '1000.0000', endingCash: '740.0000', arEntries: [], apEntries: entries, arTotal: '0.0000', apTotal: '260.0000', arCount: 0, apCount: 26,
    dynamicInflow: '0.0000', dynamicOutflow: '0.0000', deferredOut: '0.0000', apCapacity: null,
  }
  const host = document.createElement('div')
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (async () => {
    attempts++
    return attempts === 1 ? Promise.reject(new Error('offline')) : Response.json({ arEntries: [], apEntries: entries })
  }) as typeof fetch
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = originalFetch
  })
  const emptyWeek = { ...week, apEntries: [] }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <CashWeekFlyout week={emptyWeek as never} categories={[]} onClose={() => {}} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Failed to load/)
  assert.ok(!document.body.textContent?.includes('No outflows predicted this week.'))
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[role="alert"] button')?.click()
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  assert.ok(document.querySelector('button[aria-label="Previous"]'), 'previous page control is named')
  assert.ok(document.querySelector('button[aria-label="Next"]'), 'next page control is named')
  assert.equal(attempts, 2)
})
