import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment()
stubModules({ navigation: true, intl: false, authz: false, features: false, extra: {
  'next-intl': 'const t = (key) => key; export function useTranslations() { return t }',
  sonner: 'export const toast = { success() {}, error() {} }',
} })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { FairValuePricesEditor } = await import('./FairValuePricesEditor')
const price = { id: 'price-a', currency: 'BHD', unit_price: '900719925474099.1234', low_value: null, high_value: null, effective_from: '2026-10-01', effective_to: null, is_active: true }
function button(label: string) {
  const result = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  assert.ok(result, `the ${label} control is available`)
  return result
}

test('a pricing read refusal names its remedy and retry restores the actual dated prices', async (t) => {
  let refused = true
  let reads = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => {
    reads++
    return refused
      ? Response.json({ error: 'Revenue recognition is unavailable', remedy: 'Enable Revenue Recognition in Company Settings → Features' }, { status: 403 })
      : Response.json({ prices: [price] })
  }
  const root = createRoot(document.body)
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = previousFetch })
  await act(async () => root.render(React.createElement(FairValuePricesEditor, { itemId: 'item-a', canManage: true })))
  assert.match(document.body.textContent ?? '', /Revenue recognition is unavailable/)
  assert.match(document.body.textContent ?? '', /Company Settings → Features/)
  assert.ok(document.querySelector('table') === null)
  assert.equal([...document.querySelectorAll('button')].some((candidate) => candidate.textContent === 'new'), false)
  refused = false
  await act(async () => button('actions.retry').click())
  assert.equal(reads, 2)
  assert.match(document.querySelector('table')?.textContent ?? '', /900719925474099\.1234/)
})

/** The open price drawer, ignoring one still playing its exit animation. */
function liveDialog(): HTMLElement {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) => !node.closest('[data-overlay-exiting]')) as HTMLElement | undefined
  assert.ok(dialog, 'the price drawer is open')
  return dialog
}

test('a price edits in a drawer over the list; cancel writes nothing and an exact save refreshes the dated record', async (t) => {
  let current = price
  const writes: Record<string, unknown>[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      writes.push(body)
      current = { ...current, unit_price: String(body.unitPrice) }
      return Response.json({ id: price.id })
    }
    return Response.json({ prices: [current], currencies: [{ value: 'USD', label: 'USD · US Dollar' }] })
  }
  const root = createRoot(document.body)
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = previousFetch })
  await act(async () => root.render(React.createElement(FairValuePricesEditor, { itemId: 'item-a', canManage: true })))
  await act(async () => button('actions.edit').click())
  const dialog = liveDialog()
  assert.ok(document.querySelector('table'), 'the list stays behind the drawer')
  assert.equal((dialog.querySelectorAll('input')[0] as HTMLInputElement).value, price.unit_price)
  const currency = [...dialog.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'USD')) as HTMLSelectElement | undefined
  assert.ok(currency, 'currency is a select of enabled currencies, never free text')
  assert.deepEqual([...currency.options].map((option) => option.value), ['', 'BHD', 'USD'], 'a stored currency stays selectable beside the enabled ones')
  assert.equal(currency.value, 'BHD')
  await act(async () => button('actions.cancel').click())
  assert.equal(writes.length, 0)
  await act(async () => button('actions.edit').click())
  const amount = liveDialog().querySelectorAll('input')[0] as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(amount, '900719925474099.2345')
    amount.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => [...liveDialog().querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'actions.save')!.click())
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.unitPrice, '900719925474099.2345')
  assert.equal(writes[0]!.currency, 'BHD')
  assert.equal(writes[0]!.effectiveFrom, '2026-10-01')
  assert.match(document.querySelector('table')?.textContent ?? '', /900719925474099\.2345/)
})
