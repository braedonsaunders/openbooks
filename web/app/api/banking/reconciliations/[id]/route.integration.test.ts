import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { autoMatch, importStatement, markReconciled, startReconciliation } from '@openbooks/engine/src/banking.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/test-fixtures.ts'
import type { Authz } from '../../../../../lib/authz'

const enabled = !!process.env.OPENBOOKS_DB_URL
const identity: { gate: Authz | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.banking-adjustment')] = identity
// Only identity is substituted. Feature checks, routes, domain services and SQL are native.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/api/json') return next(new URL('../../../../../lib/api/json.ts', import.meta.url).href, context)
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './authz' && (context.parentURL ?? '').endsWith('/lib/feature-gates.ts')) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
      "export async function guardPermission(){return globalThis[Symbol.for('openbooks.banking-adjustment')].gate}") }
  }
  return next(specifier, context)
} })
const { PATCH } = await import('./route')

async function fixture() {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"banking":true}'::jsonb) where id=${org.orgId}`)
  await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD'
    where org_id=${org.orgId} and id=${org.accounts.bank}`)
  const entryId = randomUUID()
  await db.execute(sql`insert into journal_entries
    (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values(${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},'BANK-ADJUST',${org.date},${org.periodId},'draft','manual')`)
  await db.execute(sql`insert into journal_lines
    (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
    values(${org.orgId},${entryId},1,${org.accounts.bank},${org.subsidiaryId},100,'CAD',100,1),
      (${org.orgId},${entryId},2,${org.accounts.adjustment},${org.subsidiaryId},-100,'CAD',-100,1)`)
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where org_id=${org.orgId} and id=${entryId}`)
  const ctx = { orgId: org.orgId, userId: actorId }
  await importStatement({ accountId: org.accounts.bank, source: 'manual', currency: 'CAD',
    lines: [{ postedOn: org.date, amount: '100', description: 'Deposit', bankTransactionId: 'deposit' }] }, ctx)
  const reconciliation = await startReconciliation({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: '100' }, ctx)
  assert.equal((await autoMatch(reconciliation.id, ctx)).matched, 1)
  identity.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null } as Authz
  return { ...org, ctx, reconciliationId: reconciliation.id }
}

function patch(id: string, body: Record<string, unknown>) {
  return PATCH(new Request(`https://openbooks.test/api/banking/reconciliations/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) })
}

async function snapshot(orgId: string, id: string) {
  return (await db.execute<{ through_date: string; statement_balance: string; status: string }>(sql`
    select through_date,statement_balance,status from reconciliations where org_id=${orgId} and id=${id}`)).rows[0]!
}

async function adjustmentAudits(orgId: string, id: string) {
  return (await db.execute<{ changes: { before: { throughDate: string; statementBalance: string }; after: { throughDate: string; statementBalance: string } } }>(sql`
    select changes from audit_log where org_id=${orgId} and row_id=${id} and changes->>'mode'='session_adjustment'
    order by id`)).rows.map(row => row.changes)
}

test('bank adjustment cannot move a new session onto an already signed-off cutoff', { skip: !enabled }, async (t) => {
  const org = await fixture()
  try {
    await markReconciled(org.reconciliationId, org.ctx)
    const next = await startReconciliation({ accountId: org.accounts.bank, throughDate: '2026-07-31', statementBalance: '100' }, org.ctx)
    const before = await snapshot(org.orgId, next.id)
    const response = await patch(next.id, { throughDate: org.date })
    if (response.status === 200) {
      await markReconciled(next.id, org.ctx)
      t.diagnostic(`Old route also signed duplicate cutoff: ${JSON.stringify(await snapshot(org.orgId, next.id))}`)
    }
    assert.equal(response.status, 422, JSON.stringify(await response.json()))
    assert.deepEqual(await snapshot(org.orgId, next.id), before)
    assert.equal((await adjustmentAudits(org.orgId, next.id)).length, 0)
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank adjustment recomputes persisted status and returns the same transaction totals', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    assert.equal((await snapshot(org.orgId, org.reconciliationId)).status, 'balanced')
    const changed = await patch(org.reconciliationId, { statementBalance: '125' })
    assert.equal(changed.status, 200)
    const totals = (await changed.json()).totals
    assert.equal(totals.difference, '25.0000')
    assert.equal((await snapshot(org.orgId, org.reconciliationId)).status, 'in_progress')
    const restored = await patch(org.reconciliationId, { statementBalance: '100' })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).totals.difference, '0.0000')
    assert.equal((await snapshot(org.orgId, org.reconciliationId)).status, 'balanced')
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank adjustment refuses a cutoff that strands already matched evidence', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const before = await snapshot(org.orgId, org.reconciliationId)
    const response = await patch(org.reconciliationId, { throughDate: '2026-07-01' })
    assert.equal(response.status, 422, JSON.stringify(await response.json()))
    assert.deepEqual(await snapshot(org.orgId, org.reconciliationId), before)
    assert.equal((await adjustmentAudits(org.orgId, org.reconciliationId)).length, 0)
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank adjustment validates calendar dates before SQL and preserves the session on refusal', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const before = await snapshot(org.orgId, org.reconciliationId)
    const response = await patch(org.reconciliationId, { throughDate: '2026-02-30' })
    assert.equal(response.status, 422, JSON.stringify(await response.json()))
    assert.deepEqual(await snapshot(org.orgId, org.reconciliationId), before)
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('concurrent native bank adjustments chain audit snapshots and return their own balances', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const responses = await Promise.all(['110', '120'].map(statementBalance => patch(org.reconciliationId, { statementBalance })))
    assert.deepEqual(responses.map(response => response.status), [200, 200])
    assert.deepEqual(await Promise.all(responses.map(async response => (await response.json()).totals.statementBalance)), ['110.0000', '120.0000'])
    const audits = await adjustmentAudits(org.orgId, org.reconciliationId)
    assert.equal(audits.length, 2)
    const first = audits.find(audit => audit.before.statementBalance === '100.0000')!
    const second = audits.find(audit => audit !== first)!
    assert.ok(first)
    assert.deepEqual(second.before, first.after)
    assert.equal((await snapshot(org.orgId, org.reconciliationId)).statement_balance, second.after.statementBalance)
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})


test('bank sign-off refuses legacy overlapping cutoffs even when the balance cross-foots', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    await markReconciled(org.reconciliationId, org.ctx)
    const next = await startReconciliation({ accountId: org.accounts.bank, throughDate: '2026-07-31', statementBalance: '100' }, org.ctx)
    // Reproduce data persisted by the old adjustment route, without weakening
    // any database constraint. Sign-off must enforce the invariant itself.
    await db.execute(sql`update reconciliations set through_date=${org.date} where id=${next.id} and org_id=${org.orgId}`)
    await assert.rejects(markReconciled(next.id, org.ctx), /after the last signed-off reconciliation/)
    assert.equal((await snapshot(org.orgId, next.id)).status, 'in_progress')
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and row_id=${next.id} and action='approve'`)).rows.length, 0)
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank adjustment rejects non-string cutoff values without changing the session', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const before = await snapshot(org.orgId, org.reconciliationId)
    for (const throughDate of [['2026-07-31'], null, 20260731]) {
      const response = await patch(org.reconciliationId, { throughDate })
      assert.equal(response.status, 422, JSON.stringify(await response.json()))
    }
    assert.deepEqual(await snapshot(org.orgId, org.reconciliationId), before)
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})


test('completed bank sign-off remains idempotent after its book is deactivated', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const signed = await markReconciled(org.reconciliationId, org.ctx)
    await db.execute(sql`update accounting_books set is_active=false where org_id=${org.orgId} and id=${org.bookId}`)
    assert.deepEqual(await markReconciled(org.reconciliationId, org.ctx), signed)
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and row_id=${org.reconciliationId} and action='approve'`)).rows.length, 1)
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})
