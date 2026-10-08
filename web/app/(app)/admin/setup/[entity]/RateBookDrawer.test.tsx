import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../../testing/jsdom-env'
import { stubModules } from '../../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/setup/item-rate-books?row=book', matchMediaMatches: false, event: 'jsdom' })
stubModules({
  navigation: { pathname: '/admin/setup/item-rate-books' },
  extra: { sonner: 'export const toast={success(){},error(){}}' },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { BusinessDateProvider } = await import('../../../../../components/business-date-provider')
const { RateBookDrawer } = await import('./RateBookDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

test('saving and reopening bill-only rates preserves a blank cost and explicit policy', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const priorFetch = globalThis.fetch
  const writes: { replaceRates: boolean; laborDerivationPolicy?: string; lines: { costRate: string; billRate: string; pricingPolicy: string }[] }[] = []
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    writes.push(JSON.parse(String(init?.body)))
    return Response.json({ id: 'book', versionId: 'version' })
  }) as typeof fetch
  t.after(async () => {
    globalThis.fetch = priorFetch
    await act(async () => root.unmount())
    host.remove()
  })
  const itemId = '11111111-1111-4111-8111-111111111111'
  let generation = 0
  let billRate = '80.0000'
  const render = () => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <BusinessDateProvider today="2026-01-10">
      <RateBookDrawer key={generation} row={{ id: 'book', code: 'BILL-ONLY', name: 'Bill-only book', is_active: true }}
        latestEffectiveFrom="2025-01-01" latestEffectiveTo="2025-12-31"
        latestLaborDerivationPolicy="time_type_multipliers"
        lines={[{ itemId, unitCode: 'hour', unitName: 'Hour', baseQuantity: '1.0000', costRate: '', billRate,
          baseUnit: 'hour', pricingPolicy: 'explicit', invoicePresentation: 'rate_components', timeTypeBillRates: {} }]}
        items={[{ id: itemId, code: 'SERVICE', name: 'Service', kind: 'labor', unit: 'hour', isActive: true }]}
        currencies={[]} baseCurrency="CAD" multiCurrency={false} closeHref="/admin/setup/item-rate-books" />
    </BusinessDateProvider>
  </NextIntlClientProvider>
  const openRates = async () => {
    await act(async () => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Item rates')
      assert.ok(button)
      button.click()
      await tick()
    })
    const cost = document.querySelector<HTMLInputElement>('input[aria-label="Cost rate"]')
    assert.ok(cost)
    assert.equal(cost.value, '')
    assert.ok([...document.querySelectorAll('select')].some((node) => node.value === 'explicit'))
    assert.equal(document.querySelector('#rate-book-labor-policy')?.textContent, messages.laborPricing.derivations.time_type_multipliers)
  }
  await act(async () => { root.render(render()); await tick() })
  await openRates()
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Bill rate"]')
    assert.ok(input)
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '90')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  const save = async () => act(async () => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Save')
    assert.ok(button)
    button.click()
    await tick()
  })
  await save()
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.replaceRates, true)
  assert.equal(writes[0]!.laborDerivationPolicy, 'time_type_multipliers')
  assert.deepEqual([writes[0]!.lines[0]!.costRate, writes[0]!.lines[0]!.billRate, writes[0]!.lines[0]!.pricingPolicy], ['', '90', 'explicit'])
  billRate = '90.0000'
  generation += 1
  await act(async () => { root.render(render()); await tick() })
  await openRates()
  await save()
  assert.equal(writes.length, 2)
  assert.equal(writes[1]!.replaceRates, false, 'reopening and saving an unchanged schedule cannot publish a new version')
  assert.equal(writes[1]!.lines[0]!.costRate, '')
  assert.equal(writes[1]!.lines[0]!.pricingPolicy, 'explicit')
  assert.equal(writes[1]!.laborDerivationPolicy, undefined, 'an unchanged header save does not try to rewrite the labor policy')
  await act(async () => { (document.querySelector('#rate-book-labor-policy') as HTMLButtonElement).click(); await tick() })
  const explicitOption = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(option => option.textContent?.trim() === messages.laborPricing.derivations.explicit)
  assert.ok(explicitOption)
  await act(async () => { explicitOption.click(); await tick() })
  await save()
  assert.equal(writes.length, 3)
  assert.equal(writes[2]!.replaceRates, true, 'changing only the labor policy creates a new dated version')
  assert.equal(writes[2]!.laborDerivationPolicy, 'explicit')
  assert.deepEqual(writes[2]!.lines, writes[1]!.lines, 'a labor policy change preserves the separate item profile and unknown cost')
})
