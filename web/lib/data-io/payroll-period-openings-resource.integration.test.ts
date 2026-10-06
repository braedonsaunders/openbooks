import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { DB, withHarness } from '@openbooks/engine/src/testing/hrm-harness.ts'
import { payrollPeriodOpeningsResource } from './payroll-period-openings-resource'
import { setupPeriodOpeningFixture, periodOpeningInput } from '@openbooks/engine/src/testing/payroll-period-openings-fixture.ts'

async function setup() {
  const fixture = await setupPeriodOpeningFixture(), native = periodOpeningInput(fixture)
  const row: Record<string, unknown> = { employee: native.employeePartyId, taxYear: native.taxYear,
    subsidiaryId: native.subsidiaryId, payScheduleId: native.payScheduleId, country: native.country,
    currency: native.currency, periodStart: native.periodStart, periodEnd: native.periodEnd,
    paidThrough: native.paidThrough, expectedRevision: 'new', expectedAnnualUpdatedAt: native.expectedAnnualUpdatedAt,
    sourceReference: native.sourceReference, reason: native.reason }
  for (const [key, amount] of Object.entries(native.amounts)) row[`amount:${native.country}:${key}`] = amount
  return { ...fixture, row, resource: payrollPeriodOpeningsResource(fixture.org.orgId), context: {
    orgId: fixture.org.orgId, actorId: fixture.authorId, dryRun: false, allowedSubsidiaryIds: null } }
}
async function snapshot(orgId: string) {
  return (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'annual',(select jsonb_agg(to_jsonb(b)) from payroll_opening_balances b where org_id=${orgId}),
    'period',(select jsonb_agg(to_jsonb(o)) from payroll_period_openings o where org_id=${orgId}),
    'audit',(select jsonb_agg(to_jsonb(a)) from audit_log a where org_id=${orgId}),
    'stubs',(select jsonb_agg(to_jsonb(s)) from pay_stubs s where org_id=${orgId}),
    'ledger',(select jsonb_agg(to_jsonb(l)) from journal_lines l where org_id=${orgId})) as state`)).rows[0]!.state
}
test('bulk period preview preserves money and history; native admission exports exact facts and reviewed replay changes nothing', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const before = await snapshot(f.org.orgId)
    const preview = await f.resource.write([f.row], 'insert', { ...f.context, dryRun: true })
    assert.deepEqual(preview, { created: 1, updated: 0, failed: 0, errors: [] })
    assert.deepEqual(await snapshot(f.org.orgId), before)
    assert.equal((await f.resource.write([f.row], 'insert', f.context)).created, 1)
    const read = await f.resource.read({ allowedSubsidiaryIds: null })
    assert.equal(read.rows[0]!['amount:CA:cpp'], '11.6300')
    assert.equal(read.rows[0]!.expectedRevision, '1')
    const after = await snapshot(f.org.orgId)
    assert.deepEqual(await f.resource.write(read.rows, 'upsert', f.context), { created: 0, updated: 0, failed: 0, errors: [] })
    assert.deepEqual(await snapshot(f.org.orgId), after)
    assert.equal((await f.resource.read({ allowedSubsidiaryIds: new Set() })).rows.length, 0)
  })
})
test('period import refuses incomplete facts, cross-pack inputs, stale reviews, hidden identities and duplicate aliases before effects', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const before = await snapshot(f.org.orgId)
    for (const dryRun of [true, false]) {
      for (const [changes, message] of [
        [{ 'amount:CA:cpp': '' }, /missing.*explicit 0/],
        [{ 'amount:US:cpp': '1' }, /not declared by CA/],
        [{ 'amount:CA:cpp': '11,63' }, /write "11,63" as "11.63"/],
        [{ expectedAnnualUpdatedAt: 'stale' }, /annual opening balance changed/],
        [{ expectedRevision: '' }, /Export and review/],
        [{ employee: randomUUID() }, /unavailable or ambiguous/],
      ] as const) {
        const result = await f.resource.write([{ ...f.row, ...changes }], 'insert', { ...f.context, dryRun })
        assert.equal(result.failed, 1); assert.match(result.errors[0]!.message, message)
      }
      const keys: (readonly (string | null)[])[] = []
      const duplicate = await f.resource.write([f.row, { ...f.row, employee: String(f.row.employee).toUpperCase() }], 'insert',
        { ...f.context, dryRun, recordKeys: async values => { keys.push(values) } })
      assert.equal(duplicate.failed, 2); assert.match(duplicate.errors[0]!.message, /more than once/)
      assert.equal(keys[0]![0], keys[0]![1], 'transfer pages share the resolved employee/year key')
      assert.equal((await f.resource.write([f.row], 'insert', { ...f.context, dryRun, allowedSubsidiaryIds: new Set() })).failed, 1)
    }
    assert.deepEqual(await snapshot(f.org.orgId), before)
    assert.equal((await f.resource.write([f.row], 'insert', f.context)).created, 1)
    const after = await snapshot(f.org.orgId)
    assert.match((await f.resource.write([f.row], 'upsert', f.context)).errors[0]!.message, /annual opening balance changed|period opening changed/)
    assert.deepEqual(await snapshot(f.org.orgId), after)
  })
})
