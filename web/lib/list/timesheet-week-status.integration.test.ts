import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/platform/db'
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from '@openbooks/engine/testing/fixtures'
import { readEntityListPage } from './entity-reader'

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
test('saved week lifecycle wins over mixed entry status while totals and empty headers remain visible', enabled, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const other = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Week reviewer', 'week-reviewer'))
    const employee = randomUUID()
    const foreign = randomUUID()
    const foreignActor = await withBypassContext(() => createScratchUser(other.orgId, 'Other week reviewer', 'other-week-reviewer'))
    const emptyActor = await withBypassContext(() => createScratchUser(org.orgId, 'Restricted week reviewer', 'restricted-week-reviewer'))
    await withBypassContext(async () => {
      assert.equal((await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"timeTracking":true}'::jsonb)
        where id=${org.orgId} returning id`)).rows.length, 1)
      assert.equal((await db.execute(sql`update app_roles set permissions='["time.read"]'::jsonb
        where org_id=${org.orgId} and key='week-reviewer' returning id`)).rows.length, 1)
      assert.equal((await db.execute(sql`update app_roles set permissions='["time.read"]'::jsonb,
        subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb
        where org_id=${org.orgId} and key='restricted-week-reviewer' returning id`)).rows.length,1)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values(${foreign},${other.orgId},'person','Other week worker',${other.subsidiaryId},true,'{}'::jsonb)`)
      await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,created_by,updated_by)
        values(${randomUUID()},${other.orgId},${foreign},'2026-04-05','draft',${foreignActor},${foreignActor})`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values(${employee},${org.orgId},'employee','Week worker',${org.subsidiaryId},true,'{}'::jsonb)`)
      await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active)
        values(${randomUUID()},${org.orgId},${employee},true)`)
      for (const [week,status] of [['2026-04-05','approved'],['2026-04-12','draft']] as const) {
        await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,
          approved_by,approved_at,created_by,updated_by)
          values(${randomUUID()},${org.orgId},${employee},${week}::date,${status},
          ${status==='approved'?actor:null},${status==='approved'?new Date():null},${actor},${actor})`)
      }
      for (const [day,hours,status] of [
        ['2026-04-06','8.0000','approved'],['2026-04-07','2.0000','draft'],
        ['2026-04-20','3.0000','approved'],
      ] as const) {
        await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,status,
          is_billable,costing_basis,custom,created_by,updated_by)
          values(${randomUUID()},${org.orgId},${employee},${day}::date,${hours},${status},
          false,'actual','{}'::jsonb,${actor},${actor})`)
      }
    })
    const before = await withOrgContext(org.orgId, () => db.execute(sql`
      select id,status,hours from time_entries where org_id=${org.orgId} order by id`))
    const read = (over: Partial<Parameters<typeof readEntityListPage>[0]> = {}) => readEntityListPage({
      recordType:'timesheet_week',orgId:org.orgId,actorId:actor,allowedSubsidiaryIds:null,
      sort:'week',dir:'asc',...over,
    })
    const result = await read()
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.filteredTotal, 3)
    const week = result.rows.find(row=>String(row.week_start)==='2026-04-05')
    assert.equal(week?.status,'approved','atomic draft time cannot overwrite the recorded week decision')
    assert.equal(Number(week?.total_hours),10,'hours retain both atomic statuses')
    const empty = result.rows.find(row=>String(row.week_start)==='2026-04-12')
    assert.equal(empty?.status,'draft')
    assert.equal(Number(empty?.total_hours),0,'a saved empty week remains a real list record')
    assert.equal(result.rows.find(row=>String(row.week_start)==='2026-04-19')?.status,'approved','legacy entry-only week retains its lifecycle fold')
    const approved = await read({ filters:[{key:'status',operator:'eq',value:'approved'}] })
    assert.ok(approved.ok)
    if (approved.ok) assert.equal(approved.filteredTotal,2)
    const none = await read({ actorId:emptyActor,allowedSubsidiaryIds:new Set<string>() })
    assert.ok(none.ok)
    if (none.ok) assert.equal(none.rows.length,0)
    assert.deepEqual((await withOrgContext(org.orgId,()=>db.execute(sql`
      select id,status,hours from time_entries where org_id=${org.orgId} order by id`))).rows,before.rows,
      'list reads do not change atomic approval or financial provenance')
  } finally {
    await dropScratchOrgReporting(org.orgId)
    await dropScratchOrgReporting(other.orgId)
  }
})
