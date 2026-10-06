import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/ap', matchMediaMatches: false, scrollIntoView: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: { pathname: '/ap' } })

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { ApCockpit } = await import('./ApCockpit')
const { CommitmentsTable } = await import('../../purchasing/CommitmentsTable')

test('vendor drilldown is a named keyboard-operable button inside its table cell', async (t) => {
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
        <MoneyProvider currency="USD">
          <ApCockpit
            canConfigure={false}
            canPay={false}
            data={{
              asOf: '2026-09-24', horizonWeeks: 13, outstanding: '10.00', overdue: '0.00', overdueCount: 0,
              dueThisWeek: '0.00', dueNext30: '0.00', dpo: 0,
              summary: { outstanding: '10.00', scheduled: '0.00', pctCurrent: '1.0000', avgDays: 0, buckets: [], unplaced: { count: 0, total: '0.00' } },
              weeks: [], byVendor: [{ partyId: 'party-1', partyName: 'Ada Supplies', amount: '10.00', count: 1, overdue: '0.00', oldestDue: null }],
              worklist: [], payPlan: { weeklyCap: '0.00', restrictToSafe: false, scheduling: false, capacity: null, startingCash: '0.00', recommended: [], recommendedTotal: '0.00', deferredThisWeek: '0.00', deferredBeyondHorizon: '0.00' },
              categories: [], unavailableCategories: [], timeline: [],
            }}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
  })

  const action = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Ada Supplies')
  assert.ok(action, 'vendor drilldown renders a button with the vendor name')
  assert.equal(action.type, 'button')
  assert.equal(action.closest('tr')?.onclick, null, 'the table row itself is not the pointer-only action')
})

test('purchasing vendor drilldown is a named button inside its table cell', async (t) => {
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
        <MoneyProvider currency="USD">
          <CommitmentsTable rows={[{
            partyId: 'party-1', name: 'Ada Supplies', openPoValue: '0', openPos: 0,
            openBills: 1, billedOpen: '10', overdue: '0', oldestDue: null,
          }]} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
  })
  const action = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Ada Supplies')
  assert.ok(action, 'vendor name is a button with a text accessible name')
  assert.equal(action.closest('tr')?.onclick, null, 'the table row itself does not own the pointer-only action')
})
