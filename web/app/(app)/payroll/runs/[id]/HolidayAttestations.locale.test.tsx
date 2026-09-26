import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../../testing/jsdom-env'

await bootJsdomEnvironment({ url: 'http://localhost:4800/payroll/runs/run-1', matchMediaMatches: false })

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/fr')).default
const { HolidayAttestations } = await import('./HolidayAttestations')

test('holiday attestation controls render translated copy for a French viewer', async (t) => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    employees: [{
      employeePartyId: 'employee-1',
      name: 'Ada',
      paidOnCommission: null,
      assertions: [],
      demanding: [],
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  t.after(() => {
    globalThis.fetch = previousFetch
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    for (const child of [...document.body.children]) child.remove()
  })

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <HolidayAttestations
          runId="run-1"
          errors={[{
            employee: 'Ada',
            employeePartyId: 'employee-1',
            neededFact: 'paidOnCommission',
            message: 'Commission-pay status is required.',
          }]}
          roster={[{ employee_party_id: 'employee-1', name: 'Ada' }]}
          canAnswer
          onAnswered={() => undefined}
        />
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  assert.match(host.textContent ?? '', /Rémunération à la commission/)
  assert.doesNotMatch(host.textContent ?? '', /Paid on commission|Save & recalculate|Unanswered/)
})
