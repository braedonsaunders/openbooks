import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/accounting/changes', matchMediaMatches: false, scrollIntoView: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return {push(){},refresh(){}}}' })

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const frenchMessages = (await import('../../../../messages/fr')).default
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { LossOfControlButton } = await import('./LossOfControlButton')
const { ChangeEvidence } = await import('./ChangeEvidence')

test('loss-of-control selectors expose their field labels', async (t) => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    interest: { investment_account_id: 'investment', equity_income_account_id: 'income' },
    subsidiaries: [{ id: 'sub-1', name: 'Subsidiary', base_currency: 'CAD' }],
    accounts: [{ id: 'account-1', number: '1000', name: 'Cash', type: 'asset' }],
    eliminations: [{ id: 'elim-1', name: 'Consolidation', base_currency: 'CAD' }],
    adjustmentLines: [{ id: 'line-1', entry_number: 'J-1', posting_date: '2026-09-01', account_name: 'Goodwill', amount: '10.00', memo: null }],
  })) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = priorFetch
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-24">
          <LossOfControlButton interestId="interest-1" />
        </BusinessDateProvider>
        <NextIntlClientProvider locale="fr" messages={frenchMessages}><ChangeEvidence value={{ transfersOwnership: true }} /></NextIntlClientProvider>
      </NextIntlClientProvider>,
    )
  })
  const opener = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Record loss of control'))
  assert.ok(opener)
  await act(async () => {
    opener.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await act(async () => {
    for (const label of ['Add adjustment', 'Add reserve']) {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
      assert.ok(button, `${label} control renders`)
      button.click()
    }
  })
  const selectors = [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
  assert.ok(selectors.length >= 5, 'account, entity, adjustment, and reserve selectors render')
  for (const selector of selectors) {
    assert.ok(selector.getAttribute('aria-label'), 'each SearchSelect trigger has an accessible name')
  }
  assert.ok(['Évaluation / mesure', 'Proposition approuvée', 'Transfert de propriété', 'Oui'].every((label) => document.body.textContent?.includes(label)))
})
