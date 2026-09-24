// Payroll-collapse regression for insights: a restricted reader's cards
// aggregate the pre-collapsed grain, so no party dimension, amount filter,
// sort, or limit can isolate one employee's net pay. Totals tie out;
// granted readers see full detail. Runs in the integration partition with a
// migrated database:
//   node --import tsx --import ./engine/src/testing/database-bypass.ts \
//     --test packages/analytics/test/payroll-collapse.integration.test.ts
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, pool, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { REPORT_ENTITY_MAP } = await import('@openbooks/reports')
const { payrollRestrictedEntity } = await import('@openbooks/reports')
const { runInsightQuery } = await import('../src/execute')

const NAME_A = 'Avery Employee'
const NAME_B = 'Blake Employee'
const NET_A = '4842.17'
const NET_B = '5210.44'

function entityMap(canSeePayroll: boolean) {
  return {
    ...REPORT_ENTITY_MAP,
    ledger_lines: payrollRestrictedEntity(REPORT_ENTITY_MAP.ledger_lines, canSeePayroll),
  }
}

test('insight cards collapse payroll legs for restricted readers', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const empA = randomUUID()
    const empB = randomUUID()
    await withBypass(() => db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
      values (${empA}, ${scratch.orgId}, 'employee', ${NAME_A}, ${scratch.subsidiaryId}),
             (${empB}, ${scratch.orgId}, 'employee', ${NAME_B}, ${scratch.subsidiaryId})`))
    const payDoc = randomUUID()
    await withBypass(() => db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, subsidiary_id, currency, subtotal, tax_total, total, fx_rate, status)
      values (${payDoc}, ${scratch.orgId}, 'pay_run', 'PAY-1', ${scratch.date}, ${scratch.date}, ${scratch.subsidiaryId}, 'USD', 0, 0, 10052.61, 1, 'approved')`))
    const entryId = randomUUID()
    await withBypass(() => db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, source_document_id)
      values (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'JE-PAY-1', ${scratch.date}, ${scratch.periodId}, 'Pay run PAY-1', 'draft', 'document', ${payDoc})`))
    await withBypass(() => db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
      values (${randomUUID()}, ${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.ap}, ${scratch.subsidiaryId}, ${empA}, true, -4842.17, 'USD', -4842.17, 1, ${scratch.date}),
             (${randomUUID()}, ${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.ap}, ${scratch.subsidiaryId}, ${empB}, true, -5210.44, 'USD', -5210.44, 1, ${scratch.date}),
             (${randomUUID()}, ${scratch.orgId}, ${entryId}, 3, ${scratch.accounts.cogs}, ${scratch.subsidiaryId}, null, false, 10052.61, 'USD', 10052.61, 1, ${scratch.date})`))
    await withBypass(() => db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId}`))

    const card = {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      dimensions: [{ field: 'party_name' }],
    } as const
    const labels = { field: () => undefined, measure: () => undefined, dimension: () => undefined }
    const hidden = await runInsightQuery(pool, card, scratch.orgId, null, labels, scratch.date, undefined, entityMap(false))
    const hiddenText = JSON.stringify(hidden.rows)
    assert.ok(!hiddenText.includes(NAME_A) && !hiddenText.includes(NAME_B), 'insight leaked an employee identity')
    assert.ok(!hiddenText.includes(NET_A) && !hiddenText.includes(NET_B), 'insight leaked an individual amount')
    assert.ok(hiddenText.includes('Payroll (restricted)'), 'payroll legs must bucket under the restricted label')

    const shown = await runInsightQuery(pool, card, scratch.orgId, null, labels, scratch.date, undefined, entityMap(true))
    const shownText = JSON.stringify(shown.rows)
    assert.ok(shownText.includes(NAME_A) && shownText.includes(NET_A), 'granted insight must show full detail')
    // The card sums a balanced entry, so both sides net to zero: compare at
    // cent precision (float dust from JS summation must not fail the tie).
    const sum = (text: string): string =>
      (text.match(/-?\d+\.\d+/g)?.reduce((n, v) => n + Number(v), 0) ?? 0).toFixed(2)
    assert.equal(sum(hiddenText), sum(shownText), 'restricted insight money must tie to granted money')
    assert.equal(sum(hiddenText), '0.00')
  } finally {
    await dropScratchOrg(scratch.orgId)
  }
})
