import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __runDrawerConfirmCalls: { message?: string }[] | undefined
}

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost:4800/payments' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (typeof window.requestAnimationFrame !== 'function') {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}' }
    if (specifier === 'next/link') return { shortCircuit: true, url: 'data:text/javascript,export default function Link(p){return p.children}' }
    if (specifier === 'next-intl') return { shortCircuit: true, url: 'data:text/javascript,export function useTranslations(){const t=(key,values)=>key.endsWith("confirmPost")?`Post ${values.count} payments totalling ${values.total}`:key;t.rich=(key,values)=>key;return t}export function useLocale(){return "en"}export function useTimeZone(){return "UTC"}export function useFormatter(){return {dateTime(value){return String(value)}}}' }
    if (specifier === 'sonner') return { shortCircuit: true, url: 'data:text/javascript,export const toast={success(){},error(){}}' }
    if (specifier.endsWith('/lib/confirm')) return { shortCircuit: true, url: 'data:text/javascript,export async function confirmDialog(options){(globalThis.__runDrawerConfirmCalls??=[]).push(options);return false}' }
    return next(specifier, context)
  },
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { MoneyProvider } = await import('../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { RunDrawer, hasPaymentAdjustment } = await import('./RunDrawer')

test('posting confirmation sums live instruction amounts with exact decimal precision', async (t) => {
  globalThis.__runDrawerConfirmCalls = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    // The providers type `children` as required, so React.createElement's
    // object overload needs the children field even with runtime children.
    // eslint-disable-next-line react/no-children-prop
    root.render(React.createElement(MoneyProvider, { currency: 'USD', children:
      // eslint-disable-next-line react/no-children-prop
      React.createElement(BusinessDateProvider, { today: '2026-09-24', children:
        React.createElement(RunDrawer, {
          run: { id: 'run-1', run_number: 'RUN-1', status: 'generated', scheduled_for: null, bank_number: null, bank_name: null },
          instructions: [
            { id: 'i1', status: 'pending', payee: 'Adobe', document_number: 'PAY-1', amount: '9007199254740992.0000', payment_document_id: null, settlement_effective_on: null, bank_reference: null, return_code: null, return_reason: null },
            { id: 'i2', status: 'pending', payee: 'Regional Telecom', document_number: 'PAY-2', amount: '1.0001', payment_document_id: null, settlement_effective_on: null, bank_reference: null, return_code: null, return_reason: null },
            { id: 'i3', status: 'cancelled', payee: 'Cancelled', document_number: 'PAY-3', amount: '500.00', payment_document_id: null, settlement_effective_on: null, bank_reference: null, return_code: null, return_reason: null },
          ],
          eftConfigured: true,
          eftMissing: [],
          blockers: [],
          files: [{ id: 'file-1', status: 'approved', filename: 'run.ach', content_hash: 'hash', sequence_number: 1, payment_count: 2, total_amount: '9007199254740993.0001', currency: 'USD' }],
          events: [],
          items: [],
          canApprove: false,
        }),
      }),
    }))
  })
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  const post = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('runDrawer.postPayments')) as HTMLButtonElement | undefined
  assert.ok(post && hasPaymentAdjustment('9007199254740993.01', '0'), 'posting is available and high-precision adjustments remain visible')
  await act(async () => { post.click() })
  assert.match(globalThis.__runDrawerConfirmCalls?.[0]?.message ?? '', /Post 2 payments totalling \$9,007,199,254,740,993\.00/)
})
