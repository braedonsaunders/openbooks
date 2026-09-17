import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../../lib/auth'

/**
 * F-t07-003: a draft budget has no submit-for-approval path, so the
 * Pending approval / Approved states the list filter already offers are
 * unreachable. The actions route must move draft → pending_approval
 * (submit, budgets.manage), pending_approval → approved (approve,
 * budgets.approve) and pending_approval → draft (reject, budgets.approve),
 * revision-guarded and audit-logged like every other budget action.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __budgetActionsUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__budgetActionsUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { POST } = await import('./route')

const request = (id: string, body: unknown) =>
  new Request(`http://budget.local/api/budgets/${id}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

function asUser(id: string, orgId: string, name: string): SessionUser {
  return {
    id, orgId, name, email: `${name}@scratch.test`, roles: [], isSuperAdmin: false,
    envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id,
  }
}

async function scenarioState(orgId: string, id: string) {
  return withBypassContext(async () =>
    (await db.execute<{ status: string; revision: number; submitted_by: string | null; approved_by: string | null }>(sql`
      select status, revision, submitted_by, approved_by from budget_scenarios where id = ${id} and org_id = ${orgId}`)).rows[0]!,
  )
}

test('budget approval lifecycle: submit, approve, reject', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const manager = await withBypassContext(() => createScratchUser(org.orgId, 'Budget manager', 'budget_manager'))
    const approver = await withBypassContext(() => createScratchUser(org.orgId, 'Budget approver', 'budget_approver'))
    const scenarioId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'), '{features,budgets}', 'true') where id = ${org.orgId}`)
      await db.execute(sql`update app_roles set permissions = '["budgets.read","budgets.manage"]'::jsonb where org_id = ${org.orgId} and key = 'budget_manager'`)
      await db.execute(sql`update app_roles set permissions = '["budgets.read","budgets.approve"]'::jsonb where org_id = ${org.orgId} and key = 'budget_approver'`)
      await db.execute(sql`
        insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status, created_by, updated_by)
        values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Lifecycle operating', 'budget', 'draft', ${manager}, ${manager})`)
      // The scenario guard requires a non-zero line before submit/approve.
      await db.execute(sql`
        insert into budget_lines (org_id, scenario_id, account_id, period_id, amount, created_by, updated_by)
        values (${org.orgId}, ${scenarioId}, ${org.accounts.revenue}, ${org.periodId}, '-900.0000', ${manager}, ${manager})`)
    })

    // Submit: draft → pending_approval with the manage grant.
    state.user = asUser(manager, org.orgId, 'manager')
    const submitted = await withOrgContext(org.orgId, () =>
      POST(request(scenarioId, { action: 'submit', expectedRevision: 1 }), params(scenarioId)))
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()))
    assert.deepEqual(await submitted.json(), { revision: 2, status: 'pending_approval' })
    const pending = await scenarioState(org.orgId, scenarioId)
    assert.equal(pending.status, 'pending_approval')
    assert.equal(pending.submitted_by, manager)

    // Submitting again is a lifecycle refusal, not a silent no-op.
    const resubmit = await withOrgContext(org.orgId, () =>
      POST(request(scenarioId, { action: 'submit', expectedRevision: 2 }), params(scenarioId)))
    assert.equal(resubmit.status, 409)

    // Approve needs the approve grant, not just manage.
    const managerApprove = await withOrgContext(org.orgId, () =>
      POST(request(scenarioId, { action: 'approve', expectedRevision: 2 }), params(scenarioId)))
    assert.equal(managerApprove.status, 403)
    state.user = asUser(approver, org.orgId, 'approver')
    const approved = await withOrgContext(org.orgId, () =>
      POST(request(scenarioId, { action: 'approve', expectedRevision: 2 }), params(scenarioId)))
    assert.equal(approved.status, 200, JSON.stringify(await approved.clone().json()))
    assert.deepEqual(await approved.json(), { revision: 3, status: 'approved' })
    assert.equal((await scenarioState(org.orgId, scenarioId)).approved_by, approver)

    // Reject returns a pending budget to draft and clears the submission.
    const scenario2 = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status, created_by, updated_by)
        values (${scenario2}, ${org.orgId}, ${org.bookId}, 2026, 'Lifecycle reject', 'budget', 'draft', ${manager}, ${manager})`)
      await db.execute(sql`
        insert into budget_lines (org_id, scenario_id, account_id, period_id, amount, created_by, updated_by)
        values (${org.orgId}, ${scenario2}, ${org.accounts.revenue}, ${org.periodId}, '-100.0000', ${manager}, ${manager})`)
    })
    state.user = asUser(manager, org.orgId, 'manager')
    await withOrgContext(org.orgId, () =>
      POST(request(scenario2, { action: 'submit', expectedRevision: 1 }), params(scenario2)))
    state.user = asUser(approver, org.orgId, 'approver')
    const rejected = await withOrgContext(org.orgId, () =>
      POST(request(scenario2, { action: 'reject', expectedRevision: 2 }), params(scenario2)))
    assert.equal(rejected.status, 200, JSON.stringify(await rejected.clone().json()))
    assert.deepEqual(await rejected.json(), { revision: 3, status: 'draft' })
    const backToDraft = await scenarioState(org.orgId, scenario2)
    assert.equal(backToDraft.submitted_by, null)

    // Approving a draft directly is refused; stale revisions conflict.
    const badApprove = await withOrgContext(org.orgId, () =>
      POST(request(scenario2, { action: 'approve', expectedRevision: 3 }), params(scenario2)))
    assert.equal(badApprove.status, 409)
    state.user = asUser(manager, org.orgId, 'manager')
    const stale = await withOrgContext(org.orgId, () =>
      POST(request(scenario2, { action: 'submit', expectedRevision: 2 }), params(scenario2)))
    assert.equal(stale.status, 409)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
