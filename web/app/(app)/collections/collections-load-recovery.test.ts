import assert from 'node:assert/strict'
import test from 'node:test'

Object.assign(globalThis, {
  __recoveryCalls: [] as [string, string][],
  __recoveryAttemptId: '11111111-1111-1111-1111-111111111111',
  __recoverySql: [] as string[],
})
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({
  navigation: true,
  intl: true,
  features: true,
  authz: {
    source:
      `export async function getAuthz(){return { user: { orgId: 'org-1', id: 'user-1' }, permissions: new Set(['*']) }}` +
      `export function can(){return true}` +
      `export async function requirePermission(){return getAuthz()}`,
  },
  extra: {
    'server-only': `export {}`,
    '@openbooks/engine/src/platform/db.ts':
      `export const db = { execute: async (q) => {` +
      `const s = JSON.stringify(q); globalThis.__recoverySql.push(s);` +
      `if (s.includes('needs_authentication')) return { rows: [] };` +
      `if (s.includes("decline_kind = 'hard'")) return { rows: [] };` +
      `if (s.includes('customer_invoice')) return { rows: [` +
      `{ partyId: 'p1', currency: 'EUR' },` +
      `{ partyId: 'p1', currency: 'USD' }] };` +
      `if (s.includes(globalThis.__recoveryAttemptId)) return { rows: [{` +
      `id: globalThis.__recoveryAttemptId, invoiceId: 'inv-1', invoiceNumber: 'INV-1',` +
      `customerName: 'Attempt Co', amount: '10.00', currency: 'USD', provider: 'stripe',` +
      `providerRef: null, methodLabel: null, status: 'failed', declineCode: 'd1',` +
      `declineKind: 'hard', retryPosition: 0, nextRetryOn: null, authUrl: null,` +
      `usedBackup: false, receiptId: null, attemptedAt: '2026-09-01T00:00:00Z' }] };` +
      `return { rows: [] } } }`,
    '@openbooks/engine/payments/autopay':
      `export async function findCardsExpiringSoon(){return [` +
      `{ methodId: 'm1', partyId: 'p1', partyName: 'Billed Co', provider: 'stripe', brand: 'Visa', last4: '4242', expMonth: 10, expYear: 2026, expiresOn: '2026-10-31' },` +
      `{ methodId: 'm2', partyId: 'p2', partyName: 'Unbilled Co', provider: 'stripe', brand: null, last4: null, expMonth: 10, expYear: 2026, expiresOn: '2026-10-31' }]}` +
      `export async function getRecoveryMetrics(){return {` +
      `attempts: 2, invoicesWithFailures: 1, recoveredInvoices: 0, recoveredAmount: '0.00',` +
      `recoveredByCurrency: [], recoveryRate: null, churnPrevented: 0, awaitingAuthentication: 0,` +
      `byDeclineClass: [], byProvider: [] }}` +
      `export const MISSING_COLLECTION_POLICY = 'missing_collection_policy'`,
    '@openbooks/engine/platform/civil-date':
      `export function addCalendarDays(day){return day}`,
    '@openbooks/engine/platform/business-date':
      `export async function businessToday(){return '2026-10-01'}`,
    '../../../lib/custom-reports':
      `export async function builtInReportDefinitionId(orgId, slug){` +
      `globalThis.__recoveryCalls.push([orgId, slug]); return 'report-9'}`,
  },
})

const { loadCollections } = await import('./view.ts')

/**
 * The drill link resolves through the shared built-in resolver (which
 * ensures the catalog row and keeps tenant custom slug collisions out),
 * never a bare slug lookup that any custom report could satisfy.
 */
test('recovery resolves its drill link through the built-in report contract', async () => {
  const data = await loadCollections({})
  assert.deepEqual(globalThis.__recoveryCalls, [['org-1', 'collection-recovery-rate']])
  assert.equal(data.recovery?.recoveryReportId, 'report-9')
  assert.equal(data.recovery?.canRunReport, true)
  assert.equal(data.onRecovery, true)
  assert.ok(data.tabs.some((tab) => tab.href.includes('view=recovery')))
})

/**
 * Setup-link currency is per customer: the billed customer's own latest
 * invoice currency prices the remedy, while a customer with no invoice
 * carries null and refuses by name instead of inheriting another party's.
 * Same-day ties resolve deterministically in the database — document day,
 * then creation time, then id — so the loader's first-row win is stable.
 */
test('expiring rows carry their own party currency, never the book default', async () => {
  globalThis.__recoverySql.length = 0
  const data = await loadCollections({})
  const expiring = data.recovery?.expiring ?? []
  assert.equal(expiring.find((row) => row.partyId === 'p1')?.currency, 'EUR')
  assert.equal(expiring.find((row) => row.partyId === 'p2')?.currency, null)
  const currencyQuery = globalThis.__recoverySql.find((s) => s.includes('customer_invoice'))
  assert.ok(currencyQuery, 'the loader reads per-party invoice currencies')
  assert.ok(
    currencyQuery.includes('order by d.document_date desc, d.created_at desc, d.id desc'),
    'ties break deterministically instead of depending on scan order',
  )
})

/**
 * View tabs keep list filters, and the attempt drawer closes back onto its
 * attempts list — never a bare page that drops the view.
 */
test('view tabs preserve filters and the attempt drawer closes onto its list', async () => {
  const filtered = await loadCollections({ status: 'failed', view: 'policies' })
  const recoveryTab = filtered.tabs.find((tab) => tab.href.includes('view=recovery'))
  assert.ok(recoveryTab?.href.includes('status=failed'), 'the recovery tab keeps the list filter')

  const withAttempt = await loadCollections({ attempt: globalThis.__recoveryAttemptId })
  assert.equal(withAttempt.activeView, 'attempts')
  assert.equal(
    withAttempt.attemptDrawer?.props.drawer.closeHref,
    '/collections?view=attempts',
  )
})
