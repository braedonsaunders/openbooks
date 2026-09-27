import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { sql } = await import('drizzle-orm')
const { db, env, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { ResourcingRefusal } = await import('@openbooks/engine/src/resourcing/errors.ts')
const { loadBench, loadResourcingBoard } = await import('./queries.ts')

function written(result: { rowCount: number | null }, label: string, expected = 1): void {
  assert.equal(result.rowCount, expected, `${label} did not affect ${expected} row(s)`)
}

test('board pages unbooked people, capacity, department, and current qualifications', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const ids = { departmentA: randomUUID(), departmentB: randomUUID(), type: randomUUID() }
  const people = [
    { id: randomUUID(), name: 'Ada Staff', department: ids.departmentA, qualification: 'valid' },
    { id: randomUUID(), name: 'Bea Staff', department: ids.departmentA, qualification: 'expired' },
    { id: randomUUID(), name: 'Cam Staff', department: ids.departmentB, qualification: null },
  ]
  const firstSunday = '2026-10-04'
  const lastSunday = '2026-12-20'
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Staffing board operator', 'admin'))
    await withBypassContext(async () => {
      written(await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true,"hrm":true,"hrmCertifications":true}'::jsonb) where id = ${org.orgId}`), 'feature setup')
      written(await db.execute(sql`insert into departments(id,org_id,name,is_active) values
        (${ids.departmentA},${org.orgId},'Delivery',true),(${ids.departmentB},${org.orgId},'Advisory',true)`), 'department setup', 2)
      written(await db.execute(sql`insert into hrm_qualification_types(id,org_id,code,name,category,renewal_lead_days) values
        (${ids.type},${org.orgId},'BOARD-QUAL','Board qualification','certification',30)`), 'qualification type setup')
      for (const person of people) {
        written(await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
          values (${person.id},${org.orgId},'person',${person.name},${org.subsidiaryId},true,'{}'::jsonb)`), 'person setup')
        written(await db.execute(sql`insert into employee_roles(org_id,party_id,job_title,department_id,hired_on,is_active)
          values (${org.orgId},${person.id},'Consultant',${person.department},'2026-01-01',true)`), 'employee role setup')
        const scheduleId = randomUUID()
        written(await db.execute(sql`insert into work_schedules(id,org_id,name,employee_party_id,pattern,cycle_days,cycle_anchor,effective_from,is_active,created_by,updated_by)
          values (${scheduleId},${org.orgId},'Full time',${person.id},'cycle',7,'2026-01-04','2026-01-01',true,${actorId},${actorId})`), 'schedule setup')
        for (const dayIndex of [1, 2, 3, 4, 5]) {
          written(await db.execute(sql`insert into work_schedule_days(org_id,schedule_id,day_index,hours,created_by,updated_by)
            values (${org.orgId},${scheduleId},${dayIndex},'8',${actorId},${actorId})`), 'schedule day setup')
        }
        if (person.qualification) {
          const employmentId = randomUUID()
          written(await db.execute(sql`insert into worker_employments(id,org_id,worker_party_id,employer_subsidiary_id,revision)
            values (${employmentId},${org.orgId},${person.id},${org.subsidiaryId},1)`), 'employment setup')
          const expiresOn = person.qualification === 'expired' ? '2026-10-03' : '2026-10-05'
          written(await db.execute(sql`insert into hrm_worker_qualifications(id,org_id,employment_id,type_id,issued_on,expires_on,status)
            values (${randomUUID()},${org.orgId},${employmentId},${ids.type},'2025-01-01',${expiresOn},'valid')`), 'qualification setup')
        }
      }
    })

    const scope = new Set([org.subsidiaryId])
    const board = await withOrgContext(org.orgId, () => loadResourcingBoard(org.orgId, scope, {
      firstSunday, lastSunday, onDate: firstSunday, page: 1,
    }))
    assert.deepEqual(board.people.map((person) => person.partyId), people.map((person) => person.id))
    const unbookedBench = await withOrgContext(org.orgId, () => loadBench(org.orgId, scope, { firstSunday, lastSunday, onDate: firstSunday }))
    assert.ok(unbookedBench.some((person) => person.employeePartyId === people[0]!.id), 'a person with no assignments appears on the bench')
    const weekCount = 12
    assert.equal(board.pageSize, Math.min(50, Math.floor(520 / weekCount)))
    assert.ok(board.pageSize <= Math.floor(520 / weekCount))

    const department = await withOrgContext(org.orgId, () => loadResourcingBoard(org.orgId, scope, {
      firstSunday, lastSunday, onDate: firstSunday, departmentId: ids.departmentB,
    }))
    assert.deepEqual(department.people.map((person) => person.partyId), [people[2]!.id])
    const qualified = await withOrgContext(org.orgId, () => loadResourcingBoard(org.orgId, scope, {
      firstSunday, lastSunday, onDate: firstSunday, qualificationTypeId: ids.type,
    }))
    assert.deepEqual(qualified.people.map((person) => person.partyId), [people[0]!.id])
    assert.equal(qualified.people.some((person) => person.partyId === people[1]!.id), false, 'an expired holder is excluded')
    await assert.rejects(
      () => withOrgContext(org.orgId, () => loadResourcingBoard(org.orgId, scope, {
        firstSunday: lastSunday, lastSunday: firstSunday, onDate: firstSunday,
      })),
      (error: unknown) => error instanceof ResourcingRefusal
        && error.status === 422
        && error.code === 'invalid_week_range',
    )
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})
