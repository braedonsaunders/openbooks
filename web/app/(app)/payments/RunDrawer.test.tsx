import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

declare global {
  var __runDrawerConfirmCalls: { message?: string }[] | undefined
}

await bootJsdomEnvironment({ url: 'http://localhost:4800/payments', matchMediaMatches: false })

stubModules({
  navigation: {
    source: 'export function useRouter(){return {refresh(){}}}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
    'next-intl': 'export function useTranslations(){const t=(key,values)=>key.endsWith("confirmPost")?`Post ${values.count} payments totalling ${values.total}`:key;t.rich=(key,values)=>key;return t}export function useLocale(){return "en"}export function useTimeZone(){return "UTC"}export function useFormatter(){return {dateTime(value){return String(value)}}}',
    sonner: 'export const toast={success(){},error(){}}',
  },
})

// The confirm double stays suffix-wired: shared components import it through
// several relative spellings plus `@/`, which one exact key cannot name.
const { registerHooks: registerConfirmHook } = await import('node:module')
registerConfirmHook({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/lib/confirm')) return { shortCircuit: true, url: 'data:text/javascript,export async function confirmDialog(options){(globalThis.__runDrawerConfirmCalls??=[]).push(options);return false}' }
    return next(specifier, context)
  },
})
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
          run: { id: 'run-1', run_number: 'RUN-1', status: 'generated', scheduled_for: null, bank_number: null, bank_name: null, currency: 'USD' },
          instructions: [
            { id: 'i1', status: 'pending', payee: 'Adobe', document_number: 'PAY-1', amount: '9007199254740992.0000', currency: 'USD', payment_document_id: null, settlement_effective_on: null, bank_reference: null, return_code: null, return_reason: null },
            { id: 'i2', status: 'pending', payee: 'Regional Telecom', document_number: 'PAY-2', amount: '1.0001', currency: 'USD', payment_document_id: null, settlement_effective_on: null, bank_reference: null, return_code: null, return_reason: null },
            { id: 'i3', status: 'cancelled', payee: 'Cancelled', document_number: 'PAY-3', amount: '500.00', currency: 'USD', payment_document_id: null, settlement_effective_on: null, bank_reference: null, return_code: null, return_reason: null },
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
