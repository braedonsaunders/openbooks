import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// The Delegate picker beside a pending gate in a record drawer follows the
// native hand-off rule: the gate's direct assignee or an organization admin
// may delegate it; a reviewer holding flows.manage alone is offered nothing.
const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/platform/db')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting, grantScratchPermissions } = await import('@openbooks/engine/testing/fixtures')
const { gateDelegateOptions } = await import('./gate-delegates.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

async function pendingChangeGate(orgId: string, subsidiaryId: string, submitterId: string, assignee: { userId?: string; role?: string }): Promise<string> {
  const changeId = randomUUID()
  await db.execute(sql`
    insert into financial_changes
      (id, org_id, subsidiary_id, domain, subject_id, operation, effective_on, reason, idempotency_key, payload, before_state, submitted_by, created_by, updated_by)
    values (${changeId}, ${orgId}, ${subsidiaryId}, 'asset', ${randomUUID()}, 'revaluation', '2026-07-15', 'Year-end revaluation', ${`delegate-${changeId}`},
            '{}'::jsonb, '{}'::jsonb, ${submitterId}, ${submitterId}, ${submitterId})`)
  await db.execute(sql`update financial_changes set status = 'pending' where org_id = ${orgId} and id = ${changeId}`)
  const flowId = randomUUID()
  await db.execute(sql`insert into flows (id, org_id, name, subject_kind, enabled, graph) values (${flowId}, ${orgId}, 'Accounting event approval', 'financial_change', true, '{}'::jsonb)`)
  const runId = randomUUID()
  await db.execute(sql`insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status, created_by)
    values (${runId}, ${orgId}, ${flowId}, 'financial_change', ${changeId}, 'on_submit', 'waiting', ${submitterId})`)
  const gateId = randomUUID()
  await db.execute(sql`insert into flow_gates
    (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, group_key, quorum, status, assignee_user_id, assignee_role)
    values (${gateId}, ${orgId}, ${flowId}, ${runId}, 'gate', 'financial_change', ${changeId}, 'Approve the revaluation', 'gate', 'any', 'pending',
            ${assignee.userId ?? null}, ${assignee.role ?? null})`)
  return gateId
}

test('only the direct assignee or an organization admin is offered Delegate on a pending gate', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const { submitter, assignee, reviewer, admin, direct, byRole } = await withBypassContext(async () => {
      const submitter = await createScratchUser(org.orgId, 'Asset Accountant', 'asset_accountant')
      const assignee = await createScratchUser(org.orgId, 'Controller', 'controller')
      const reviewer = await createScratchUser(org.orgId, 'Flow Manager', 'flow_manager')
      await grantScratchPermissions(org.orgId, reviewer, ['flows.manage', 'flows.approve'])
      const admin = await createScratchUser(org.orgId, 'Organization Admin', 'admin')
      const direct = await pendingChangeGate(org.orgId, org.subsidiaryId, submitter, { userId: assignee })
      const byRole = await pendingChangeGate(org.orgId, org.subsidiaryId, submitter, { role: 'controller' })
      return { submitter, assignee, reviewer, admin, direct, byRole }
    })
    const names = async (viewer: string, gate: string | null) =>
      (await withBypassContext(() => gateDelegateOptions(org.orgId, viewer, gate))).map((option) => option.name)

    const offered = await names(assignee, direct)
    assert.ok(offered.length > 0, 'the direct assignee may hand the gate on')
    assert.ok(!offered.includes('Controller'), 'never to themselves')
    assert.ok((await names(admin, direct)).length > 0, 'an organization admin may delegate it')
    assert.deepEqual(await names(reviewer, direct), [], 'flows.manage alone does not make a hand-off the delegate path accepts')
    assert.deepEqual(await names(submitter, direct), [])
    // A role-held gate has no direct assignee: only an admin may delegate it.
    assert.deepEqual(await names(assignee, byRole), [])
    assert.ok((await names(admin, byRole)).length > 0)
    assert.deepEqual(await names(admin, null), [], 'no pending gate, no picker')
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})
