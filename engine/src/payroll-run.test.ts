import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, env } from './db.ts'
import { createPayRun } from './payroll-run.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from './test-fixtures.ts'

const DB = !!env.OPENBOOKS_DB_URL

test(
  'createPayRun enforces a restricted subsidiary scope inside its transaction',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    const actorId = (await seedFlowActors(org.orgId)).adminId
    const childSubsidiaryId = randomUUID()
    const scheduleId = randomUUID()
    try {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country,
                                  tax_ids, is_elimination, is_active, custom)
        values (${childSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Child Co', 'CAD', 'CA',
                '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year,
                                   anchor_period_end, pay_date_offset_days, subsidiary_id,
                                   is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Child biweekly', 'biweekly', 26,
                '2026-07-18', 3, ${childSubsidiaryId}, true, ${actorId}, ${actorId})`)

      await assert.rejects(
        createPayRun({
          orgId: org.orgId,
          actorId,
          payScheduleId: scheduleId,
          periodStart: '2026-07-05',
          periodEnd: '2026-07-18',
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        }),
        /pay schedule not found/,
        'a schedule outside the caller scope is opaque to the direct engine caller',
      )

      const concurrent = await Promise.allSettled([
        createPayRun({
          orgId: org.orgId,
          actorId,
          payScheduleId: scheduleId,
          periodStart: '2026-07-05',
          periodEnd: '2026-07-18',
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        }),
        createPayRun({
          orgId: org.orgId,
          actorId,
          payScheduleId: scheduleId,
          periodStart: '2026-07-05',
          periodEnd: '2026-07-18',
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        }),
      ])
      assert.deepEqual(
        concurrent.map((result) => result.status),
        ['rejected', 'rejected'],
        'concurrent out-of-scope callers are both refused before either can write',
      )

      const writes = await db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from documents
         where org_id = ${org.orgId} and kind = 'pay_run'`)
      assert.equal(writes.rows[0]?.count, 0, 'the rejected scope check writes no run')

      const allowed = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: '2026-07-05',
        periodEnd: '2026-07-18',
        allowedSubsidiaryIds: new Set([childSubsidiaryId]),
      })
      assert.ok(allowed.documentId, 'an in-scope schedule remains creatable')
    } finally {
      await dropScratchOrgReporting(org.orgId)
    }
  },
)
