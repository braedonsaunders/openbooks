import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db } from './db.ts'
import { createPayRun, PayrollError } from './payroll-run.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from './test-fixtures.ts'

const invalidPeriods = [
  { name: 'impossible calendar date', periodStart: '2026-02-30', periodEnd: '2026-03-07' },
  { name: 'inverted period', periodStart: '2026-07-18', periodEnd: '2026-07-05' },
  { name: 'partial explicit period', periodStart: '2026-06-01' },
  { name: 'pay date before period end', periodStart: '2026-07-05', periodEnd: '2026-07-18', payDate: '2026-07-17' },
  { name: 'impossible pay date', periodStart: '2026-07-05', periodEnd: '2026-07-18', payDate: '2026-02-30' },
]
for (const { name, ...dates } of invalidPeriods) {
  test(`pay run refuses ${name} without allocating a document or number`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg()
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId
      const scheduleId = randomUUID()
      await db.execute(sql`update orgs set settings = settings || '{"features":{"payroll":true}}'::jsonb where id = ${org.orgId}`)
      await db.execute(sql`insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Boundary schedule', 'biweekly', 26, '2026-07-18', 3, true, ${actorId}, ${actorId})`)
      const snapshot = async () => (await db.execute(sql`select
        (select count(*) from documents where org_id = ${org.orgId}) as documents,
        (select count(*) from pay_runs where org_id = ${org.orgId}) as runs,
        (select jsonb_agg(to_jsonb(s) order by s.id) from number_sequences s where org_id = ${org.orgId}) as sequences`)).rows
      const before = await snapshot()
      await assert.rejects(createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId, ...dates }), PayrollError)
      assert.deepEqual(await snapshot(), before)
    } finally { await dropScratchOrgReporting(org.orgId) }
  })
}
