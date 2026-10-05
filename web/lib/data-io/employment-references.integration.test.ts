import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/platform/database'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from '@openbooks/engine/src/testing/fixtures.ts'
import { RefResolver } from './resource-core'
import { setupResource } from './setup-resources'
import { PAYROLL_VACATION_TERMS_ENTITY } from '../setup/payroll-vacation-terms'

test('employment references preserve exact episodes and vacation imports remain tenant scoped and audited', { skip: !process.env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const org = await createScratchOrg(), other = await createScratchOrg()
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId
    const employmentId = await seedWorkerEmployment(org.orgId, org.customerId, org.subsidiaryId)
    const successorId = await seedWorkerEmployment(org.orgId, org.customerId, org.subsidiaryId)
    const foreignId = await seedWorkerEmployment(other.orgId, other.customerId, other.subsidiaryId)
    const target = { resource: 'worker-employments', by: 'id' }
    const resolver = new RefResolver(org.orgId)
    assert.equal(await resolver.resolveId(target, employmentId), employmentId, 'a saved employment episode resolves')
    assert.equal(await resolver.resolveId(target, successorId), successorId, 'a second episode is never collapsed into the first')
    assert.equal(await resolver.resolveId(target, foreignId), null, 'another organization cannot supply an employment')
    assert.equal(await resolver.resolveId(target, randomUUID()), null, 'a syntactically valid missing identity is refused')
    for (const value of ['Employee name', '1048', '']) assert.equal(await resolver.resolveId(target, value), null, 'a worker label cannot choose an episode')

    const planId = randomUUID()
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"payroll":true}'::jsonb) where id=${org.orgId}`)
    await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,system_key,unit,direction,accrual_method,accrual_value,cap_behavior,created_by,updated_by)
      values(${planId},${org.orgId},'VAC','Vacation','vacation','money','accrue','percent_of_earnings','4','warn',${actorId},${actorId})`)
    const resource = setupResource(PAYROLL_VACATION_TERMS_ENTITY, org.orgId)
    const row = { planId, employmentId, method: 'accrue', percentFloor: '6.0000', effectiveFrom: '2026-01-03', effectiveTo: '2026-01-09', reason: 'Dated source vacation election' }
    const context = { orgId: org.orgId, actorId, permissions: new Set(['*']), allowedSubsidiaryIds: null, dryRun: true }
    const snapshot = async () => (await db.execute(sql`select jsonb_build_object(
      'terms',(select jsonb_agg(to_jsonb(t)) from payroll_vacation_terms t where org_id=${org.orgId}),
      'employment',(select jsonb_agg(to_jsonb(e) order by e.id) from worker_employments e where org_id=${org.orgId}),
      'audit',(select jsonb_agg(to_jsonb(a)) from audit_log a where org_id=${org.orgId})) as state`)).rows[0]!.state
    const before = await snapshot()
    const preview = await resource.write([row], 'insert', context)
    assert.equal(preview.failed, 0, JSON.stringify(preview.errors))
    assert.equal(preview.created, 1)
    assert.deepEqual(await snapshot(), before, 'preview must not change terms, employment or audit')
    for (const dryRun of [true, false]) {
      const refused = await resource.write([{ ...row, employmentId: foreignId }], 'insert', { ...context, dryRun })
      assert.equal(refused.failed, 1)
      assert.match(refused.errors[0]!.message, /employmentId.*not found/)
      assert.deepEqual(await snapshot(), before, 'foreign references leave no effect')
    }
    const result = await resource.write([row], 'insert', { ...context, dryRun: false })
    assert.equal(result.failed, 0, JSON.stringify(result.errors))
    assert.equal(result.created, 1)
    const saved = (await db.execute(sql`select employment_id,plan_id,method,percent_floor::text,effective_from::text,effective_to::text,reason from payroll_vacation_terms where org_id=${org.orgId}`)).rows
    assert.deepEqual(saved, [{ employment_id: employmentId, plan_id: planId, method: 'accrue', percent_floor: '6.0000', effective_from: row.effectiveFrom, effective_to: row.effectiveTo, reason: row.reason }])
    const audit = (await db.execute<{ actor_id: string; action: string; changes: { after?: { reason?: string } } }>(sql`select actor_id,action,changes from audit_log where org_id=${org.orgId} and table_name='payroll_vacation_terms'`)).rows
    const attributed = audit.filter(entry => entry.actor_id === actorId && entry.action === 'insert')
    assert.ok(attributed.length > 0, 'the import records an actor-attributed creation')
    assert.ok(attributed.some(entry => entry.changes.after?.reason === row.reason), 'the audit preserves the reason for the dated election')
  } finally { await dropScratchOrgReporting(org.orgId); await dropScratchOrgReporting(other.orgId) }
}))
