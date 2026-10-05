import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/platform/database'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from '@openbooks/engine/src/testing/fixtures.ts'
import { payrollProfileEmployment } from '@openbooks/engine/payroll/setup'
import { payrollEmploymentLinksResource } from './payroll-employment-links-resource'
import { createPayRun } from '@openbooks/engine/src/payroll/run-lifecycle.ts'
import { payRunReadiness } from '@openbooks/engine/src/payroll/readiness.ts'

async function fixture() {
  const { orgId, subsidiaryId } = await createScratchOrg()
  const actorId = (await seedFlowActors(orgId)).adminId
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${orgId} and key='admin'`)
  await db.execute(sql`update orgs set settings=settings || '{"features":{"payroll":true}}'::jsonb where id=${orgId}`)
  const employeeId = randomUUID(), scheduleId = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
    values (${employeeId},${orgId},'person','Historical payroll employee',${subsidiaryId})`)
  await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end,pay_date_offset_days)
    values (${scheduleId},${orgId},'Weekly', 'weekly',52,'2026-01-03',6)`)
  await db.execute(sql`insert into employee_payroll_profiles(org_id,employee_party_id,pay_schedule_id,country,province,pay_basis)
    values (${orgId},${employeeId},${scheduleId},'CA','ON','salary')`)
  const employmentId = await seedWorkerEmployment(orgId, employeeId, subsidiaryId)
  const row = { employee: employeeId, employment: employmentId, reason: 'Verified native employment and source employee crosswalk' }
  const context = { orgId, actorId, allowedSubsidiaryIds: null, dryRun: false }
  return { orgId, subsidiaryId, actorId, employeeId, scheduleId, employmentId, row, context, resource: payrollEmploymentLinksResource(orgId) }
}

test('employment link preview leaves all records intact; apply audits the profile only and replay changes nothing', async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    const snapshot = async () => (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
      'profiles',(select jsonb_agg(to_jsonb(p)) from employee_payroll_profiles p where org_id=${fx.orgId}),
      'employments',(select jsonb_agg(to_jsonb(e)) from worker_employments e where org_id=${fx.orgId}),
      'audit',(select jsonb_agg(to_jsonb(a)) from audit_log a where org_id=${fx.orgId})) as state`)).rows[0]!.state
    const before = await snapshot()
    const candidate = (await fx.resource.read({ allowedSubsidiaryIds: null })).rows[0]!
    assert.equal(candidate.employment, fx.employmentId)
    assert.equal(candidate.currentEmployment, null, 'an exported proposal is not a saved link')
    assert.deepEqual(await fx.resource.write([fx.row], 'upsert', { ...fx.context, dryRun: true }), { created: 0, updated: 1, failed: 0, errors: [] })
    assert.deepEqual(await snapshot(), before)
    const employmentBefore = (await db.execute(sql`select to_jsonb(e) as row from worker_employments e where org_id=${fx.orgId}`)).rows
    assert.equal((await fx.resource.write([fx.row], 'upsert', fx.context)).updated, 1)
    assert.equal((await db.execute<{ employment_id: string }>(sql`select employment_id from employee_payroll_profiles where org_id=${fx.orgId}`)).rows[0]!.employment_id, fx.employmentId)
    assert.deepEqual((await db.execute(sql`select to_jsonb(e) as row from worker_employments e where org_id=${fx.orgId}`)).rows, employmentBefore)
    const audit = (await db.execute<{ changes: { before: unknown; after: unknown; reason: string }; actor_id: string }>(sql`select changes,actor_id from audit_log where org_id=${fx.orgId} and table_name='employee_payroll_profiles'`)).rows
    assert.equal(audit.length, 1); assert.equal(audit[0]!.actor_id, fx.actorId)
    assert.deepEqual(audit[0]!.changes.before, { employmentId: null })
    assert.deepEqual(audit[0]!.changes.after, { employmentId: fx.employmentId })
    assert.equal(audit[0]!.changes.reason, fx.row.reason)
    const after = await snapshot()
    assert.equal((await fx.resource.write([fx.row], 'upsert', fx.context)).updated, 0)
    assert.deepEqual(await snapshot(), after)
    assert.equal((await fx.resource.read({ allowedSubsidiaryIds: null })).rows[0]!.employment, fx.employmentId)
    assert.equal((await fx.resource.read({ allowedSubsidiaryIds: new Set() })).rows.length, 0)
  } finally { await dropScratchOrgReporting(fx.orgId) }
}))

test('employment links refuse wrong workers, conflicting links, duplicates, hidden entities, unauthorized actors and disabled Payroll in preview and apply', async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    for (const dryRun of [true, false]) {
      for (const [row, context, message] of [
        [{ ...fx.row, employment: randomUUID() }, fx.context, /does not belong to this employee/],
        [{ ...fx.row, reason: '' }, fx.context, /reason or source reference/],
        [fx.row, { ...fx.context, allowedSubsidiaryIds: new Set<string>() }, /not available in your legal entity/],
        [fx.row, { ...fx.context, actorId: randomUUID() }, /manage permission/],
      ] as const) {
        const result = await fx.resource.write([row], 'upsert', { ...context, dryRun })
        assert.equal(result.failed, 1); assert.match(result.errors[0]!.message, message)
      }
      const duplicates = await fx.resource.write([fx.row, fx.row], 'upsert', { ...fx.context, dryRun })
      assert.equal(duplicates.failed, 2); assert.match(duplicates.errors[0]!.message, /more than once/)
    }
    assert.equal((await db.execute<{ employment_id: string | null }>(sql`select employment_id from employee_payroll_profiles where org_id=${fx.orgId}`)).rows[0]!.employment_id, null)
    const otherEpisode = await seedWorkerEmployment(fx.orgId, fx.employeeId, fx.subsidiaryId)
    assert.equal(await payrollProfileEmployment(db, fx.orgId, fx.employeeId, fx.subsidiaryId, null), null, 'ambiguous episodes are never chosen automatically')
    await fx.resource.write([fx.row], 'upsert', fx.context)
    for (const dryRun of [true, false]) {
      const conflict = await fx.resource.write([{ ...fx.row, employment: otherEpisode }], 'upsert', { ...fx.context, dryRun })
      assert.equal(conflict.failed, 1); assert.match(conflict.errors[0]!.message, /already linked to a different employment/)
    }
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','false') where id=${fx.orgId}`)
    for (const dryRun of [true, false]) assert.match((await fx.resource.write([fx.row], 'upsert', { ...fx.context, dryRun })).errors[0]!.message, /Company Settings → Features/)
  } finally { await dropScratchOrgReporting(fx.orgId) }
}))

test('run readiness names unlinked employee profiles before calculation and clears the blocker after audited linking', async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2025-12-28', periodEnd: '2026-01-03' })
    const before = await payRunReadiness(fx.orgId, run.documentId)
    const blocker = before.items.find(item => item.code === 'employee.noEmployment')
    assert.equal(blocker?.severity, 'blocker')
    assert.deepEqual(blocker?.employees, [{ partyId: fx.employeeId, name: 'Historical payroll employee' }])
    await fx.resource.write([fx.row], 'upsert', fx.context)
    assert.equal((await payRunReadiness(fx.orgId, run.documentId)).items.some(item => item.code === 'employee.noEmployment'), false)
  } finally { await dropScratchOrgReporting(fx.orgId) }
}))
