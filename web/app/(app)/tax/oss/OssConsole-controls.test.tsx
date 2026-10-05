import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/tax/oss', matchMediaMatches: false })
;(globalThis as Record<string, unknown>).Event = window.Event
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: true, intl: false, extra: { sonner: 'export const toast={success(){},error(){}};export function Toaster(){return null}' } })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { OssConsole } = await import('./OssConsole')
const tick = () => new Promise(resolve => setTimeout(resolve, 15))

async function mount(today = '2028-02-15') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><BusinessDateProvider today={today}><OssConsole setupHref="/tax/setup" /></BusinessDateProvider></NextIntlClientProvider>); await tick() })
  return { host, async close() { await act(async () => root.unmount()); host.remove() } }
}
async function change(node: HTMLSelectElement | HTMLInputElement, value: string) {
  const prototype = node instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
  await act(async () => { node.dispatchEvent(new window.Event('change', { bubbles: true })); await tick() })
}

test('switching OSS to IOSS selects a complete calendar month including leap February', async () => {
  const view = await mount()
  try {
    const dates = [...view.host.querySelectorAll<HTMLInputElement>('input[type="date"]')]
    assert.deepEqual(dates.map(d => d.value), ['2028-01-01','2028-03-31'])
    await change(dates[0]!, '2028-02-01')
    await change(view.host.querySelector('select')!, 'ioss')
    assert.deepEqual(dates.map(d => d.value), ['2028-02-01','2028-02-29'])
    await change(view.host.querySelector('select')!, 'union')
    assert.deepEqual(dates.map(d => d.value), ['2028-01-01','2028-03-31'])
    await change(dates[0]!, '2028-12-01')
    await change(view.host.querySelector('select')!, 'ioss')
    assert.deepEqual(dates.map(d => d.value), ['2028-12-01','2028-12-31'])
  } finally { await view.close() }
})

test('OSS money uses exact rounding and keeps large decimal amounts intact', async () => {
  const prior = globalThis.fetch
  globalThis.fetch = async url => String(url).startsWith('/api/tax/oss-returns?') ? Response.json({ scheme: 'union', identificationState: 'DE', registrationNumber: 'EU123', from: '2028-01-01', to: '2028-03-31', currency: 'EUR', totalBase: '9007199254740993.0050', totalTax: '1.0050', lines: [{ consumptionCountry: 'FR', ratePercent: '20.0050', baseAmount: '9007199254740993.0050', taxAmount: '1.0050', kind: 'supply', correctionQuarter: null }] }) : Response.json({}, { status: 404 })
  const view = await mount()
  try {
    const button = [...view.host.querySelectorAll('button')].find(b => b.textContent?.trim() === messages.tax.oss.prepare)!
    await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
    assert.match(view.host.textContent!, /9,007,199,254,740,993\.01/)
    assert.match(view.host.textContent!, /1\.01/)
    assert.match(view.host.textContent!, /20\.01\s*%/)
    assert.ok(view.host.querySelector('a[download]'))
    await change(view.host.querySelector('select')!, 'ioss')
    assert.equal(view.host.querySelector('a[download]'), null, 'previous quarter cannot be exported under a monthly scheme')
  } finally { await view.close(); globalThis.fetch = prior }
})
