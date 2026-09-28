import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { sql } = await import('drizzle-orm')
const { db, env, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadUtilizationFacts, loadEngagementFacts, RESOURCING_REPORT_PLANS } = await import('./report-facts.ts')
const { shapeSummarizedRows, summarizeRows } = await import('@openbooks/reports')

test('utilization reads every person beyond one availability page and engagement names unpriced assignments', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const projectId = randomUUID()
  const firstSunday = '2026-04-05'
  try {
    await withBypassContext(async () => {
      const feature = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true}'::jsonb) where id = ${org.orgId} returning id`)
      assert.equal(feature.rowCount, 1)
      const employees = await db.execute(sql`with generated as (
        select gen_random_uuid() as id, n from generate_series(1, 521) as n
      ), inserted as (
        insert into parties(id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        select id, ${org.orgId}, 'person', 'Report person ' || n, ${org.subsidiaryId}, true, '{}'::jsonb from generated
        returning id, display_name
      )
      insert into employee_roles(org_id, party_id, job_title, hired_on, is_active)
      select ${org.orgId}, id, 'Analyst', '2026-01-01', true from inserted`)
      assert.equal(employees.rowCount, 521)
      const project = await db.execute(sql`insert into projects(id,org_id,name,customer_id,subsidiary_id)
        values (${projectId},${org.orgId},'Unpriced engagement',${org.customerId},${org.subsidiaryId}) returning id`)
      assert.equal(project.rowCount, 1)
      const assignment = await db.execute(sql`insert into res_assignments(org_id,project_id,employee_party_id,week_start,planned_hours,is_billable,bill_item_id,booking,state,created_by,updated_by)
        values (${org.orgId},${projectId},(select id from parties where org_id=${org.orgId} and display_name='Report person 1'),${firstSunday},'8.0000',true,null,'hard','active',null,null) returning id`)
      assert.equal(assignment.rowCount, 1)
    })

    const scope = new Set([org.subsidiaryId])
    const utilizationRows = await withOrgContext(org.orgId, () => loadUtilizationFacts(org.orgId, scope, { firstSunday, lastSunday: firstSunday }))
    assert.equal(utilizationRows.length, 521)

    const engagementRows = await withOrgContext(org.orgId, () => loadEngagementFacts(org.orgId, scope, { firstSunday, lastSunday: firstSunday }))
    const unpriced = engagementRows.filter((row) => row.unpriced_count === true)
    assert.equal(unpriced.length, 1)
    assert.equal(unpriced[0]?.unpriced_hours, '8.0000')
    const plan = RESOURCING_REPORT_PLANS.engagement({
      margin: 'Margin', marginPercent: 'Margin percent', unpricedCount: 'Unpriced assignments', uncostedCount: 'Uncosted assignments',
      pricedCount: 'Priced assignments', costedCount: 'Costed assignments', noRevenue: 'No revenue recorded', noCost: 'No labor cost recorded', undefined: 'Undefined',
    }, 'project')
    const result = shapeSummarizedRows(summarizeRows(engagementRows, plan), plan, engagementRows)
    const group = result.groups[0]!
    assert.equal(group.rows[0]?.[9], 1)
    assert.ok(!result.summary.some((item) => /forecast revenue|forecast cost|margin/i.test(item.label)),
      `the unpriced fixture must publish no monetary or margin summary, got ${result.summary.map((item) => item.label).join(', ')}`)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
