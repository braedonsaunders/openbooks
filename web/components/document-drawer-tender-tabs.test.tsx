import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/cash-sales', matchMediaMatches: false })
const { stubModules } = await import('../testing/stub-modules')
stubModules({ navigation: true, intl: false, extra: { sonner: 'export const toast={success(){},error(){},warning(){}}' } })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { MoneyProvider } = await import('./money-provider')
const { DocumentDrawer } = await import('./document-drawer')
const { DOC_KINDS } = await import('../lib/document-kinds')
const { defaultFormLayout } = await import('@openbooks/customization')
const tick = () => new Promise(resolve => setTimeout(resolve, 25))

test('cash-sale tenders have a separate active body and preserve unresolved code drafts in one dialog', async () => {
  const prior = globalThis.fetch
  const writes: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push(String(input))
    return Response.json({ rows: [], attachments: [] })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><MoneyProvider currency="USD"><DocumentDrawer
        payload={{ doc: { id: '', kind: 'cash_sale', status: 'draft', currency: 'USD', document_date: '2026-10-05', document_number: 'CASH-101', subtotal: '10.00', tax_total: '0.00', total: '10.00', custom: { tenders: [{ kind: 'stored_value', accountId: 'clearing', amount: '10.00' }] } }, lines: [] }}
        config={DOC_KINDS.cash_sale!} basePath="/cash-sales" accounts={[]} departments={[]} projects={[]} headerDefs={[]} lineDefs={[]} canCreate canPost createMode
        layout={defaultFormLayout('cash_sale')} tenderAccounts={[{ id: 'clearing', number: '1100', name: 'Clearing' }]} storedValueEnabled
      /></MoneyProvider></NextIntlClientProvider>)
      await tick()
    })
    const dialog = document.querySelector('[role="dialog"]')
    assert.ok(dialog, 'the cash-sale record must own one dialog')
    async function tab(label: string) {
      const button = [...dialog!.querySelectorAll('button')].find(node => node.hasAttribute('aria-pressed') && node.textContent?.trim() === label)
      assert.ok(button, `expected a reachable ${label} tab`)
      await act(async () => { button.click(); await tick() })
    }
    const code = dialog.querySelector<HTMLInputElement>('input[placeholder="' + messages.ar.tenders.codePlaceholder + '"]')
    assert.ok(code, 'the stored-value code editor stays mounted while inactive')
    assert.ok(code.closest('[hidden]'), 'tenders cannot stack beneath the lines body')
    await tab(messages.ar.tenders.title)
    assert.equal(code.closest('[hidden]'), null)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(code, 'unresolved-gift-code')
      code.dispatchEvent(new window.Event('input', { bubbles: true }))
      await tick()
    })
    await tab(messages.common.auditTrail.tabs.details)
    assert.ok(code.closest('[hidden]'))
    await tab(messages.ar.tenders.title)
    assert.equal(document.querySelector('[role="dialog"]'), dialog, 'switching concepts cannot replace the drawer shell')
    assert.equal(dialog.querySelector('input[placeholder="' + messages.ar.tenders.codePlaceholder + '"]'), code)
    assert.equal(code.value, 'unresolved-gift-code', 'an unresolved code draft cannot disappear on a tab switch')
    assert.deepEqual(writes, [], 'switching tabs neither saves nor resolves a stored-value code')
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = prior }
})
