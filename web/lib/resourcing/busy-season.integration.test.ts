import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { upsertAssignment } = await import('@openbooks/engine/src/resourcing/assignments.ts')
const { ResourcingRefusal } = await import('@openbooks/engine/src/resourcing/errors.ts')
const { loadBusySeason } = await import('./busy-season.ts')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

type Seed = {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  actorId: string
  ids: ReturnType<typeof seedIds>
}

function seedIds() {
  return {
    taxDept: randomUUID(), advisoryDept: randomUUID(), alice: randomUUID(), bob: randomUUID(),
    carol: randomUUID(), project: randomUUID(), openStatus: randomUUID(), openOpp: randomUUID(),
  }
}

async function seedOrg(): Promise<Seed> {
  const org = await withBypassContext(() => createScratchOrg())
  const ids = seedIds()
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Busy-season operator', 'admin'))
  await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true}'::jsonb, true) where id = ${org.orgId}`)
    await db.execute(sql`insert into departments(id,org_id,name,subsidiary_id) values
      (${ids.taxDept},${org.orgId},'Tax',${org.subsidiaryId}),
      (${ids.advisoryDept},${org.orgId},'Advisory',${org.subsidiaryId})`)
    for (const [partyId, name, title, dept] of [
      [ids.alice, 'Alice Adler', 'Senior Tax Associate', ids.taxDept],
      [ids.bob, 'Bob Berger', 'Senior Tax Associate', ids.taxDept],
      [ids.carol, 'Carol Costa', 'Analyst', ids.advisoryDept],
    ] as const) {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${partyId}, ${org.orgId}, 'person', ${name}, ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, department_id, hired_on, is_active) values (${org.orgId}, ${partyId}, ${title}, ${dept}, '2026-01-01', true)`)
    }
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${ids.project}, ${org.orgId}, ${org.subsidiaryId}, 'BUSY-1', 'Busy-season engagement', ${org.customerId}, 'active', true, '{}'::jsonb)`)
    await db.execute(sql`insert into crm_opportunity_statuses(id,org_id,key,name,sequence,probability,is_closed,is_won,is_active) values (${ids.openStatus},${org.orgId},'busy-open','Open',10,40,false,false,true)`)
    await db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,status_id,forecast_category,probability,currency,is_active) values (${ids.openOpp},${org.orgId},'BUSY-OPEN','Open tax work',${ids.openStatus},'upside',40,'USD',true)`)
  })
  return { org, actorId, ids }
}

async function addPerson(seed: Seed, partyId: string, name: string, title: string | null, dept: string | null): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${partyId}, ${seed.org.orgId}, 'person', ${name}, ${seed.org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, department_id, hired_on, is_active) values (${seed.org.orgId}, ${partyId}, ${title}, ${dept}, '2026-01-01', true)`)
  })
}

async function addLines(seed: Seed, lines: { id?: string; dept: string; title: string; first: string; last: string; hours: string; opp?: string }[]): Promise<string[]> {
  return withBypassContext(async () => {
    const written: string[] = []
    for (const line of lines) {
      const id = line.id ?? randomUUID()
      await db.execute(sql`insert into res_demand_lines(id,org_id,department_id,job_title,first_week,last_week,hours_per_week,opportunity_id) values (${id},${seed.org.orgId},${line.dept},${line.title},${line.first},${line.last},${line.hours},${line.opp ?? null})`)
      written.push(id)
    }
    return written
  })
}

async function addPlan(seed: Seed, rows: { subject: { employeePartyId: string } | { jobTitle: string }; projectId: string; weekStart: string; plannedHours: string }[]): Promise<string[]> {
  return withBypassContext(async () => {
    const written: string[] = []
    for (const row of rows) {
      const result = await upsertAssignment({
        orgId: seed.org.orgId, actorId: seed.actorId, allowedSubsidiaryIds: null,
        projectId: row.projectId, weekStart: row.weekStart, plannedHours: row.plannedHours,
        booking: 'hard', source: 'manual', ...row.subject,
      })
      written.push(result.assignment.id)
    }
    return written
  })
}

const load = (seed: Seed, year = '2026') =>
  withOrgContext(seed.org.orgId, () => loadBusySeason(seed.org.orgId, new Set([seed.org.subsidiaryId]), { seasonYear: year }))

const refused = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ResourcingRefusal)
  assert.equal(error.code, code)
  return true
}

test('busy-season gaps, spans, evidence, and fail-closed refusals', enabled, async (t) => {
  const orgs: Seed[] = []
  t.after(async () => {
    for (const seed of orgs) await withBypassContext(() => dropScratchOrg(seed.org.orgId))
  })
  const main = await seedOrg()
  orgs.push(main)
  const { ids } = main
  const extra = {
    hiddenSub: randomUUID(), hiddenDept: randomUUID(), hiddenProject: randomUUID(),
    inactiveProject: randomUUID(), closedProject: randomUUID(), cancelledProject: randomUUID(),
    wonStatus: randomUUID(), wonOpp: randomUUID(), manualLine: randomUUID(), pipelineLine: randomUUID(),
    advisoryLine: randomUUID(), hiddenLine: randomUUID(), wonLine: randomUUID(),
  }
  await withBypassContext(async () => {
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${extra.hiddenSub},${main.org.orgId},${main.org.subsidiaryId},'Hidden resourcing entity','CAD','CA')`)
    await db.execute(sql`insert into departments(id,org_id,name,subsidiary_id) values (${extra.hiddenDept},${main.org.orgId},'Hidden practice',${extra.hiddenSub})`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values
      (${extra.hiddenProject}, ${main.org.orgId}, ${extra.hiddenSub}, 'BUSY-9', 'Hidden engagement', ${main.org.customerId}, 'active', true, '{}'::jsonb),
      (${extra.inactiveProject}, ${main.org.orgId}, ${main.org.subsidiaryId}, 'BUSY-7', 'Inactive engagement', ${main.org.customerId}, 'active', false, '{}'::jsonb),
      (${extra.closedProject}, ${main.org.orgId}, ${main.org.subsidiaryId}, 'BUSY-6', 'Closed engagement', ${main.org.customerId}, 'closed', true, '{}'::jsonb),
      (${extra.cancelledProject}, ${main.org.orgId}, ${main.org.subsidiaryId}, 'BUSY-5', 'Cancelled engagement', ${main.org.customerId}, 'cancelled', true, '{}'::jsonb)`)
    await db.execute(sql`insert into crm_opportunity_statuses(id,org_id,key,name,sequence,probability,is_closed,is_won,is_active) values (${extra.wonStatus},${main.org.orgId},'busy-won','Won',20,100,true,true,true)`)
    await db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,status_id,forecast_category,probability,currency,is_active) values (${extra.wonOpp},${main.org.orgId},'BUSY-WON','Won tax work',${extra.wonStatus},'upside',100,'USD',true)`)
  })
  await addLines(main, [
    { id: extra.manualLine, dept: ids.taxDept, title: 'Senior Tax Associate', first: '2026-01-04', last: '2026-01-11', hours: '10.0000' },
    { id: extra.pipelineLine, dept: ids.taxDept, title: 'Tax Manager', first: '2026-01-04', last: '2026-01-04', hours: '20.0000', opp: ids.openOpp },
    { id: extra.advisoryLine, dept: ids.advisoryDept, title: 'Analyst', first: '2026-01-04', last: '2026-01-04', hours: '30.0000' },
    { id: extra.hiddenLine, dept: extra.hiddenDept, title: 'Analyst', first: '2026-01-04', last: '2026-01-04', hours: '100.0000' },
    { id: extra.wonLine, dept: ids.taxDept, title: 'Consultant', first: '2026-01-04', last: '2026-01-04', hours: '50.0000', opp: extra.wonOpp },
  ])
  const written = await addPlan(main, [
    { subject: { jobTitle: 'Senior Tax Associate' }, projectId: ids.project, weekStart: '2026-01-04', plannedHours: '40.0000' },
    { subject: { jobTitle: 'Senior Tax Associate' }, projectId: ids.project, weekStart: '2026-01-11', plannedHours: '8.0000' },
    { subject: { employeePartyId: ids.alice }, projectId: ids.project, weekStart: '2026-01-04', plannedHours: '30.0000' },
    { subject: { employeePartyId: ids.carol }, projectId: ids.project, weekStart: '2026-01-04', plannedHours: '10.0000' },
    { subject: { jobTitle: 'Analyst' }, projectId: extra.hiddenProject, weekStart: '2026-01-04', plannedHours: '40.0000' },
  ])
  const data = await load(main)
  assert.deepEqual(data.spans, [{ firstSunday: '2026-01-04', lastSunday: '2026-01-11' }])
  assert.equal(data.gaps.length, 1)
  const gap = data.gaps[0]!
  assert.equal(gap.departmentId, ids.taxDept)
  assert.equal(gap.weekStart, '2026-01-04')
  // 10.0000 manual + 8.0000 live-weighted pipeline; 30.0000 named + 40.0000
  // generic plan; 80.0000 standard-tier capacity over two staff.
  assert.equal(gap.demandHours, '18.0000')
  assert.equal(gap.planHardHours, '70.0000')
  assert.equal(gap.planHours, '70.0000')
  assert.equal(gap.capacityHours, '80.0000')
  assert.equal(gap.gapHours, '8.0000')
  assert.equal(gap.suggestedJobTitle, 'Senior Tax Associate')
  assert.deepEqual(gap.evidence.demandLineIds, [extra.manualLine, extra.pipelineLine])
  assert.deepEqual(gap.evidence.opportunityIds, [ids.openOpp])
  assert.deepEqual(gap.evidence.assignmentIds, [written[0], written[2]].sort())
  assert.deepEqual(gap.evidence.capacityPersonIds, [ids.alice, ids.bob].sort())
  assert.ok(!data.gaps.some((row) => row.departmentId === ids.advisoryDept), 'the exactly-met week is omitted')
  assert.ok(!data.gaps.some((row) => row.weekStart === '2026-01-11'), 'the under-capacity week is omitted')
  assert.ok(!data.gaps.some((row) => row.departmentId === extra.hiddenDept), 'out-of-scope rows are excluded')
  assert.ok(data.projects.some((project) => project.id === ids.project))
  assert.ok(!data.projects.some((project) => project.id === extra.hiddenProject))
  assert.ok(!data.projects.some((project) => project.id === extra.inactiveProject), 'inactive projects cannot be chosen')
  assert.ok(!data.projects.some((project) => project.id === extra.closedProject), 'terminal projects cannot be chosen')
  assert.ok(!data.projects.some((project) => project.id === extra.cancelledProject), 'terminal projects cannot be chosen')
  assert.deepEqual((await load(main, '2030')).gaps, [])
  await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"resourcing":false}'::jsonb,true) where id=${main.org.orgId} returning id`)
  })
  await assert.rejects(load(main), (error: unknown) =>
    typeof error === 'object' && error !== null && 'digest' in error && error.digest === 'NEXT_HTTP_ERROR_FALLBACK;404')

  const split = await seedOrg()
  orgs.push(split)
  const dave = randomUUID()
  await addPerson(split, dave, 'Dave Duda', 'Analyst', split.ids.taxDept)
  await addPlan(split, [
    { subject: { jobTitle: 'Analyst' }, projectId: split.ids.project, weekStart: '2026-01-04', plannedHours: '8.0000' },
  ])
  await assert.rejects(load(split), refused('busy_season_generic_title_ambiguous'))

  const vacant = await seedOrg()
  orgs.push(vacant)
  const erin = randomUUID()
  await addPerson(vacant, erin, 'Erin Eder', 'Senior Tax Associate', null)
  await addPlan(vacant, [
    { subject: { jobTitle: 'Senior Tax Associate' }, projectId: vacant.ids.project, weekStart: '2026-01-04', plannedHours: '8.0000' },
    { subject: { employeePartyId: erin }, projectId: vacant.ids.project, weekStart: '2026-01-04', plannedHours: '8.0000' },
  ])
  await assert.rejects(load(vacant), (error: unknown) => {
    refused('busy_season_person_department_ambiguous')(error)
    assert.match((error as Error).message, /Erin Eder/)
    assert.match((error as Error & { remedy: string }).remedy, /exactly one active department/)
    return true
  })

  const varied = await seedOrg()
  orgs.push(varied)
  await addLines(varied, [
    { dept: varied.ids.taxDept, title: 'Senior Tax Associate', first: '2026-01-04', last: '2026-01-04', hours: '10.0000' },
  ])
  await addPlan(varied, [
    { subject: { jobTitle: 'Senior Tax Associate' }, projectId: varied.ids.project, weekStart: '2026-01-04', plannedHours: '8.0000' },
  ])
  await withBypassContext(async () => {
    await db.execute(sql`insert into work_schedules (org_id, employee_party_id, pattern, effective_from, is_active, created_by, updated_by) values (${varied.org.orgId}, ${varied.ids.bob}, 'varies', '2026-01-01', true, ${varied.actorId}, ${varied.actorId})`)
  })
  await assert.rejects(load(varied), (error: unknown) => {
    refused('capacity_unknown')(error)
    assert.match((error as Error & { remedy: string }).remedy, /cycle schedule/)
    return true
  })

  const floating = await seedOrg()
  orgs.push(floating)
  const frank = randomUUID()
  await addPerson(floating, frank, 'Frank Vogel', 'Senior Tax Associate', null)
  await addPlan(floating, [
    { subject: { jobTitle: 'Senior Tax Associate' }, projectId: floating.ids.project, weekStart: '2026-01-04', plannedHours: '8.0000' },
  ])
  await assert.rejects(load(floating), (error: unknown) => {
    refused('busy_season_capacity_department_ambiguous')(error)
    assert.match((error as Error).message, /Frank Vogel/)
    assert.match((error as Error & { remedy: string }).remedy, /exactly one active department/)
    return true
  })

  const untitled = await seedOrg()
  orgs.push(untitled)
  const gina = randomUUID()
  await addPerson(untitled, gina, 'Gina Gasser', null, untitled.ids.taxDept)
  await addPlan(untitled, [
    { subject: { jobTitle: 'Senior Tax Associate' }, projectId: untitled.ids.project, weekStart: '2026-01-04', plannedHours: '8.0000' },
    { subject: { employeePartyId: gina }, projectId: untitled.ids.project, weekStart: '2026-01-04', plannedHours: '8.0000' },
  ])
  await assert.rejects(load(untitled), (error: unknown) => {
    refused('busy_season_person_title_missing')(error)
    assert.match((error as Error).message, /Gina Gasser/)
    assert.match((error as Error & { remedy: string }).remedy, /job title/)
    return true
  })
})
