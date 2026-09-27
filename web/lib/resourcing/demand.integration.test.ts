import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { sql } = await import('drizzle-orm')
const { db, env, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadDemandWeeks } = await import('./demand.ts')

test('demand expands visible weeks and weights live CRM opportunities', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const ids = Object.fromEntries(['hiddenSub', 'visibleDept', 'hiddenDept', 'openStatus', 'wonStatus', 'openOpp', 'wonOpp', 'omittedOpp', 'manualLine', 'pipelineLine', 'wonLine', 'omittedLine', 'hiddenLine'].map((name) => [name, randomUUID()])) as Record<string, string>
  try {
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${ids.hiddenSub},${org.orgId},${org.subsidiaryId},'Hidden resourcing entity','CAD','CA')`)
      await db.execute(sql`insert into departments(id,org_id,name,subsidiary_id) values
        (${ids.visibleDept},${org.orgId},'Visible practice',${org.subsidiaryId}),
        (${ids.hiddenDept},${org.orgId},'Hidden practice',${ids.hiddenSub})`)
      await db.execute(sql`insert into crm_opportunity_statuses(id,org_id,key,name,sequence,probability,is_closed,is_won,is_active) values
        (${ids.openStatus},${org.orgId},'demand-open','Open',10,40,false,false,true),
        (${ids.wonStatus},${org.orgId},'demand-won','Won',20,100,true,true,true)`)
      await db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,status_id,forecast_category,probability,currency,is_active) values
        (${ids.openOpp},${org.orgId},'DEMAND-OPEN','Open consulting work',${ids.openStatus},'upside',40,'CAD',true),
        (${ids.wonOpp},${org.orgId},'DEMAND-WON','Won consulting work',${ids.wonStatus},'upside',100,'CAD',true),
        (${ids.omittedOpp},${org.orgId},'DEMAND-OMITTED','Omitted consulting work',${ids.openStatus},'omitted',40,'CAD',true)`)
      await db.execute(sql`insert into res_demand_lines(id,org_id,department_id,job_title,first_week,last_week,hours_per_week,opportunity_id) values
        (${ids.manualLine},${org.orgId},${ids.visibleDept},'Analyst','2026-04-05','2026-04-19','10.0000',null),
        (${ids.pipelineLine},${org.orgId},${ids.visibleDept},'Consultant','2026-04-12','2026-04-12','10.0000',${ids.openOpp}),
        (${ids.wonLine},${org.orgId},${ids.visibleDept},'Consultant','2026-04-12','2026-04-12','10.0000',${ids.wonOpp}),
        (${ids.omittedLine},${org.orgId},${ids.visibleDept},'Consultant','2026-04-12','2026-04-12','10.0000',${ids.omittedOpp}),
        (${ids.hiddenLine},${org.orgId},${ids.hiddenDept},'Analyst','2026-04-12','2026-04-12','10.0000',null)`)
      const off = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"resourcing":false}'::jsonb,true) where id=${org.orgId} returning id`)
      assert.equal(off.rows.length, 1)
    })
    const window = { firstSunday: '2026-04-12', lastSunday: '2026-04-19' }
    await assert.rejects(
      withOrgContext(org.orgId, () => loadDemandWeeks(org.orgId, new Set([org.subsidiaryId]), window)),
      (error: unknown) => typeof error === 'object' && error !== null && 'digest' in error && error.digest === 'NEXT_HTTP_ERROR_FALLBACK;404',
    )
    await withBypassContext(async () => {
      const on = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"resourcing":true}'::jsonb,true) where id=${org.orgId} returning id`)
      assert.equal(on.rows.length, 1)
    })
    const rows = await withOrgContext(org.orgId, () => loadDemandWeeks(org.orgId, new Set([org.subsidiaryId]), window))
    assert.ok(rows.every((row) => row.departmentId !== ids.hiddenDept), 'hidden departments contribute no rows')
    const manual = rows.filter((row) => row.lineId === ids.manualLine)
    assert.deepEqual(manual.map((row) => row.weekStart), ['2026-04-12', '2026-04-19'], 'the window clips a three-week line to two weeks')
    const pipeline = rows.find((row) => row.lineId === ids.pipelineLine)
    assert.ok(pipeline)
    assert.equal(pipeline.weightedHours, '4.0000')
    assert.equal(pipeline.probability, 40)
    const won = rows.find((row) => row.lineId === ids.wonLine)
    assert.ok(won)
    assert.equal(won.basis, 'excluded')
    assert.equal(won.excludedReason, 'won')
    assert.equal(won.weightedHours, '0.0000')
    const omitted = rows.find((row) => row.lineId === ids.omittedLine)
    assert.ok(omitted)
    assert.equal(omitted.basis, 'excluded')
    assert.equal(omitted.excludedReason, 'omitted')
    assert.equal(omitted.weightedHours, '0.0000')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
