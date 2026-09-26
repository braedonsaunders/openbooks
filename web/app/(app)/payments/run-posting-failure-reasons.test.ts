import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../../testing/stub-modules'

// a partially failed posting toasted per-instruction reasons but
// persisted only counts, so the activity feed showed "0 sent · N failed"
// with no reason anywhere. The engine now stores the failures list on the
// run_posting_failed event; the feed must render it.

stubModules({
  navigation: {
    source: 'export default function Stub(){return null}export function useRouter(){return null}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Stub(){return null}export function useRouter(){return null}',
    'next-intl': 'export function useTranslations(){return (k)=>k}export function useLocale(){return "en"}export function useTimeZone(){return "UTC"}export function NextIntlClientProvider(p){return p.children}',
    sonner: 'export const toast={};export function Toaster(){return null}',
  },
})

// The confirm double stays suffix-wired: shared components import it through
// several relative spellings plus `@/`, which one exact key cannot name.
const { registerHooks: registerConfirmHook } = await import('node:module')
registerConfirmHook({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){return true}',
      }
    }
    return next(specifier, context)
  },
})

const { postingEventReason } = await import('./RunDrawer.tsx')

const t = (() => {
  throw new Error('must not translate when reasons are present')
}) as never

function event(details: Record<string, unknown>) {
  return {
    id: 'event-1',
    event_type: 'run_posting_failed',
    actor_name: null,
    created_at: '2026-09-17T12:00:00.000000Z',
    details,
  }
}

test('per-instruction reasons render as payee (reason) pairs', () => {
  assert.equal(
    postingEventReason(
      event({
        posted: 0,
        failureCount: 2,
        incompleteInstructions: 2,
        failures: [
          { payee: 'Adobe', error: 'AP is closed for this period and accounting book' },
          { payee: 'Regional Telecom', error: 'AP is closed for this period and accounting book' },
        ],
      }),
      t,
    ),
    'Adobe (AP is closed for this period and accounting book); Regional Telecom (AP is closed for this period and accounting book)',
  )
})

test('malformed failure entries never break the tally fallback', () => {
  assert.equal(
    postingEventReason(
      event({ posted: 0, failureCount: 2, incompleteInstructions: 2, failures: [null, 'oops', {}] }),
      ((key: string, values: { posted: number; failed: number; pending: number }) =>
        `${values.posted}/${values.failed}/${values.pending}`) as never,
    ),
    '0/2/2',
  )
})

test('the crash reason still renders when no failures list exists', () => {
  assert.equal(
    postingEventReason(event({ error: 'run lock lost' }), t),
    'run lock lost',
  )
})
