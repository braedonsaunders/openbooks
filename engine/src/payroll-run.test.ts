import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, env } from './db.ts'
import { allocateProportionally, createPayRun } from './payroll-run.ts'
import { PayrollError } from './payroll-error.ts'
import { abs, add, cmp, div, neg, sum } from './money.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from './test-fixtures.ts'

test('allocateProportionally splits exactly with the remainder on the last bucket', () => {
  const splits = allocateProportionally('100.0000', [
    { weight: '1', target: 'a' },
    { weight: '1', target: 'b' },
    { weight: '1', target: 'c' },
  ])
  assert.deepEqual(splits.map((split) => split.amount), ['33.3300', '33.3300', '33.3400'])
  assert.equal(sum(splits.map((split) => split.amount)), '100.0000')
})

test('allocateProportionally never emits a negative split on half-cent shares', () => {
  // $0.02 across four equal jobs: every exact share is half a cent. Rounding
  // each share up independently leaves the remainder bucket at -$0.01, which
  // would land on the stub as a negative employer line.
  const splits = allocateProportionally('0.0200', [
    { weight: '1', target: 'a' },
    { weight: '1', target: 'b' },
    { weight: '1', target: 'c' },
    { weight: '1', target: 'd' },
  ])
  assert.deepEqual(splits.map((split) => split.amount), ['0.0000', '0.0000', '0.0100', '0.0100'])
  assert.equal(sum(splits.map((split) => split.amount)), '0.0200')
})

test('allocateProportionally pays a zero-weight bucket nothing, even last', () => {
  // A job with no hours in the split population must never receive rounding
  // money: the old last-absorbs-remainder design paid it the leftover cents.
  const splits = allocateProportionally('100.0000', [
    { weight: '1', target: 'a' },
    { weight: '1', target: 'b' },
    { weight: '0', target: 'c' },
  ])
  assert.deepEqual(splits.map((split) => split.amount), ['50.0000', '50.0000', '0.0000'])
  const zeroFirst = allocateProportionally('100.0000', [
    { weight: '0', target: 'a' },
    { weight: '3', target: 'b' },
  ])
  assert.deepEqual(zeroFirst.map((split) => split.amount), ['0.0000', '100.0000'])
})

test('allocateProportionally keeps every share within one cent of its exact target', () => {
  // Seven uneven jobs over a prime total: every exact share is fractional, so
  // this exercises floors, remainders and tie-breaking together.
  const weights = ['1', '2', '3', '4', '5', '6', '7']
  const splits = allocateProportionally('123.4500', weights.map((weight, index) => ({ weight, target: index })))
  assert.equal(sum(splits.map((split) => split.amount)), '123.4500')
  const totalWeight = '28'
  for (const [index, split] of splits.entries()) {
    const exact = div('123.4500', div(totalWeight, weights[index]!))
    const drift = abs(add(split.amount, neg(exact)))
    assert.ok(cmp(drift, '0.01') < 0, `bucket ${index} drifts ${drift} from its exact share`)
    assert.ok(cmp(split.amount, '0') >= 0, `bucket ${index} keeps the amount's sign`)
  }
})

test('allocateProportionally preserves the sign of a negative amount', () => {
  const splits = allocateProportionally('-0.0200', [
    { weight: '1', target: 'a' },
    { weight: '1', target: 'b' },
    { weight: '1', target: 'c' },
    { weight: '1', target: 'd' },
  ])
  for (const split of splits) {
    assert.ok(cmp(split.amount, '0') <= 0, `split keeps the negative sign: ${split.amount}`)
  }
  assert.equal(sum(splits.map((split) => split.amount)), '-0.0200')
})

test('allocateProportionally refuses a sub-cent amount instead of misallocating it', () => {
  // 1.90c over 19 equal jobs: the old dust handling parked the whole 1.90c
  // on the last bucket (ideal share 0.10c), breaking the within-one-cent
  // bound. Both native call sites pass cent-exact stub money, so a sub-cent
  // input is a caller bug and must fail loudly and deterministically.
  const buckets = Array.from({ length: 19 }, (_, index) => ({ weight: '1', target: index }))
  assert.throws(
    () => allocateProportionally('0.0190', buckets),
    (error) => error instanceof PayrollError && /cent-exact/.test(error.message),
  )
})

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
