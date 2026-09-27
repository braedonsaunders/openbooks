import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { sql } = await import('drizzle-orm')
const { db, env, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadWeek } = await import('../../app/api/timesheets/_lib.ts')
const { loadPlannedWeek } = await import('./timesheet-prefill.ts')

test('planned timesheet weeks include only visible hard active bookings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const ids = Object.fromEntries(['actor', 'employee', 'otherEmployee', 'hiddenSub', 'visible', 'soft', 'released', 'hidden'].map((key) => [key, randomUUID()])) as Record<string, string>
  try {
    await withBypassContext(async () => {
      ids.actor = await createScratchUser(org.orgId, 'Timesheet operator', 'admin')
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"resourcing":true}'::jsonb,true) where id=${org.orgId}`)
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${ids.hiddenSub},${org.orgId},${org.subsidiaryId},'Hidden subsidiary','USD','US')`)
      for (const [id, name] of [[ids.employee, 'Consultant'], [ids.otherEmployee, 'Other consultant']]) {
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values(${id},${org.orgId},'person',${name},${org.subsidiaryId},true,'{}'::jsonb)`)
        await db.execute(sql`insert into employee_roles(org_id,party_id,job_title,hired_on,is_active) values(${org.orgId},${id},'Consultant','2026-01-01',true)`)
      }
      for (const [id, sub, code] of [[ids.visible, org.subsidiaryId, 'PREFILL-V'], [ids.soft, org.subsidiaryId, 'PREFILL-S'], [ids.released, org.subsidiaryId, 'PREFILL-R'], [ids.hidden, ids.hiddenSub, 'PREFILL-H']]) {
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom) values(${id},${org.orgId},${sub},${code},${code},${org.customerId},'active',true,'{}'::jsonb)`)
      }
      const assignments = [
        [ids.visible, ids.employee, '2026-10-04', 'hard', 'active'], [ids.soft, ids.employee, '2026-10-04', 'soft', 'active'],
        [ids.released, ids.employee, '2026-10-04', 'hard', 'released'], [ids.visible, ids.employee, '2026-10-11', 'hard', 'active'],
        [ids.visible, ids.otherEmployee, '2026-10-04', 'hard', 'active'], [ids.hidden, ids.employee, '2026-10-04', 'hard', 'active'],
      ]
      for (const [project, employee, week, booking, state] of assignments) {
        await db.execute(sql`insert into res_assignments(org_id,project_id,employee_party_id,week_start,planned_hours,is_billable,bill_item_id,booking,state,created_by,updated_by) values(${org.orgId},${project},${employee},${week},'8.0000',true,${org.items.service},${booking},${state},${ids.actor},${ids.actor})`)
      }
    })
    const visible = await withOrgContext(org.orgId, () => loadPlannedWeek(org.orgId, ids.employee!, '2026-10-04', new Set([org.subsidiaryId])))
    assert.deepEqual(visible, [{ projectId: ids.visible, itemId: org.items.service, isBillable: true, plannedHours: '8.0000' }])
    await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"resourcing":false}'::jsonb,true) where id=${org.orgId}`))
    assert.deepEqual(await withOrgContext(org.orgId, () => loadPlannedWeek(org.orgId, ids.employee!, '2026-10-04', null)), [])
    await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"resourcing":true}'::jsonb,true) where id=${org.orgId}`))
    const empty = await withOrgContext(org.orgId, () => loadWeek(org.orgId, ids.employee!, '2026-10-04', new Set([org.subsidiaryId])))
    assert.equal(empty.status, 'empty')
    assert.equal(empty.planned.length, 1)
    const header = await withBypassContext(() => db.execute(sql`update timesheet_weeks set status='submitted' where org_id=${org.orgId} and employee_party_id=${ids.employee} and week_start='2026-10-04' returning id`))
    assert.equal(header.rows.length, 1)
    const submitted = await withOrgContext(org.orgId, () => loadWeek(org.orgId, ids.employee!, '2026-10-04', new Set([org.subsidiaryId])))
    assert.deepEqual(submitted.planned, [])
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(org.orgId))
  }
})
