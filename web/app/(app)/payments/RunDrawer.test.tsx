import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test, { type TestContext } from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/payments?view=runs' })
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'self']) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    ;(globalThis as Record<string, unknown>)[key] = domWindow[key]
  }
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const virtual = (source: string) => ({ shortCircuit: true as const, url: `data:text/javascript,${encodeURIComponent(source)}` })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return virtual('export function useRouter(){return {push(){},refresh(){},replace(){},back(){}}}')
    if (specifier === 'next/link') return virtual('export default function Link(props){return globalThis.React.createElement("a",props,props.children)}')
    if (specifier === 'sonner') return virtual('export const toast={success(){},error(){}}')
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { RunDrawer } = await import('./RunDrawer')

const run = { id: randomUUID(), run_number: 'RUN-00001', status: 'generated', scheduled_for: null, bank_number: '1000', bank_name: 'Operating Cash' }
const approvedFile = { id: randomUUID(), status: 'approved', filename: 'payments.ach', content_hash: 'ab'.repeat(32), sequence_number: 1, payment_count: 2, total_amount: '9007199254740993.00', currency: 'USD' }
const instruction = (amount: string, payee: string) => ({
  id: randomUUID(), status: 'pending', payee, document_number: null, amount,
  payment_document_id: null, settlement_effective_on: null, bank_reference: null,
  return_code: null, return_reason: null,
})

test('the run summary totals only live instructions with exact ledger precision', async (t: TestContext) => {
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
          <BusinessDateProvider today="2026-09-24">
            <RunDrawer
              run={run}
              instructions={[instruction('9007199254740992.00', 'First vendor'), instruction('1.00', 'Second vendor'), { ...instruction('5.00', 'Cancelled vendor'), status: 'cancelled' }]}
              eftConfigured
              eftMissing={[]}
              blockers={[]}
              files={[approvedFile]}
              events={[]}
              items={[]}
              canApprove
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
  })

  const summary = [...document.querySelectorAll('strong')].find((element) => /9,007,199,254,740,993\.00/.test(element.textContent ?? ''))
  assert.ok(summary, 'the summary must show the exact total for the two live instructions, excluding the cancelled one')
})
