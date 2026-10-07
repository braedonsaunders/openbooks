import assert from 'node:assert/strict'
import test from 'node:test'

const metrics = {
  attempts: 3,
  invoicesWithFailures: 2,
  recoveredInvoices: 1,
  recoveredAmount: '120.00',
  recoveredByCurrency: [{ currency: 'USD', amount: '120.00' }],
  recoveryRate: 0.5,
  churnPrevented: 0,
  awaitingAuthentication: 0,
  byDeclineClass: [{ declineClass: 'soft', failedAttempts: 2, recoveredInvoices: 1, recoveryRate: 0.5 }],
  byProvider: [{ provider: 'stripe', failedAttempts: 2, recoveredInvoices: 1, recoveryRate: 0.5 }],
}
const state = { mode: 'missing-policy' as 'missing-policy' | 'other-error' | 'ok' }
Object.assign(globalThis, { __collectionsPolicyNoticeState: state })
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({
  navigation: true,
  intl: true,
  authz: {
    source:
      `export async function getAuthz(){return { user: { orgId: 'org-1' }, permissions: new Set(['*']) }}` +
      `export function can(){return true}` +
      `export async function requirePermission(){return getAuthz()}`,
  },
  features: true,
  extra: {
    '../../../lib/custom-reports': `export async function builtInReportDefinitionId(orgId, slug) { if (orgId !== 'org-1' || slug !== 'collection-recovery-rate') throw new Error('unexpected report definition lookup'); return '00000000-0000-4000-8000-000000000001' }`,
    '@openbooks/engine/src/platform/db.ts': `export const db = { execute: async () => ({ rows: [] }) }`,
    '@openbooks/engine/platform/business-date': `export async function businessToday(){return '2026-10-05'}`,
    '@openbooks/engine/payments/autopay':
      `export const MISSING_COLLECTION_POLICY = 'missing_collection_policy';` +
      `const coded = (message) => { const error = new Error(message); error.code = MISSING_COLLECTION_POLICY; return error };` +
      `const mode = () => globalThis.__collectionsPolicyNoticeState.mode;` +
      `export async function getRecoveryMetrics(){` +
      `const m = mode();` +
      `if (m === 'missing-policy') throw coded('no active collection policy for customer invoices; activate one in Setup');` +
      `if (m === 'other-error') throw new Error('recovery metrics could not be read; try again');` +
      `return ${JSON.stringify(metrics)}}` +
      `export async function findCardsExpiringSoon(){return []}`,
  },
})

const { isMissingCollectionPolicy, loadCollections } = await import('./view')

test('a missing collection policy is a setup notice, not a page failure', async () => {
  state.mode = 'missing-policy'
  const data = await loadCollections()
  assert.equal(data.recovery, null)
  assert.deepEqual(data.policyNotice, {
    title: 'collections.recovery.policyNotice.title',
    description: 'collections.recovery.policyNotice.description',
    actionLabel: 'collections.recovery.policyNotice.action',
    // Collection policies live in the shell's Policies view: the setup
    // entity is rehomed there, so no /admin/setup page exists for it.
    actionHref: '/collections?view=policies',
  })
  // The rest of the worklist still renders around the notice.
  assert.equal(data.worklistHref, '/ar')
})

test('any other recovery failure still throws', async () => {
  state.mode = 'other-error'
  await assert.rejects(loadCollections(), /recovery metrics could not be read/)
})

test('an active policy loads recovery facts with no notice', async () => {
  state.mode = 'ok'
  const data = await loadCollections()
  assert.equal(data.policyNotice, null)
  assert.equal(data.recovery?.metrics.attempts, 3)
})

test('only the coded missing-policy refusal reads as a missing policy', () => {
  const coded = Object.assign(new Error('no active collection policy for customer invoices; x'), {
    code: 'missing_collection_policy',
  })
  assert.equal(isMissingCollectionPolicy(coded), true)
  // The message alone never qualifies: copy may change, the code is the contract.
  assert.equal(isMissingCollectionPolicy(new Error('no active collection policy for customer invoices; x')), false)
  assert.equal(isMissingCollectionPolicy(new Error('recovery metrics could not be read; try again')), false)
  assert.equal(isMissingCollectionPolicy(null), false)
})
