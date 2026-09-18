import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * AR/AP aging is a point-in-time statement: the `asOf` boundary must scope
 * BOTH the document set and the open balances. The repo's own audit harness
 * (engine/src/harness/scenario.ts, `subledger-gl-tieout`) reconstructs the
 * subledger "point-in-time as-of the cutoff (payments applied after it don't
 * reduce the balance, and their GL is excluded too)". Aging that reads the
 * live cached `documents.open_balance` silently drops invoices settled after
 * `asOf`, so a July aging run in September disagrees with the July control
 * balance, the partner snapshot, the register closing, and the partner
 * statement closing — and is not reproducible.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/db.ts')) as typeof import('@openbooks/engine/src/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { agingByParty, agingDetail } = (await import(root + 'web/lib/reports/aging.ts')) as typeof import('./aging')
const { partnerBalances } = (await import(root + 'web/lib/reports/statements.ts')) as typeof import('./statements')
const { partyRegister, partnerStatement } = (await import(root + 'web/lib/reports/registers.ts')) as typeof import('./registers')

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

async function postEntry(org: ScratchOrg, periodId: string, date: string, memo: string, legs: [string, string, string | null][]): Promise<string> {
  const entry = randomUUID()
  const num = `AGE-${memo}-${entry.slice(0, 6)}`
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, ${date}, ${periodId}, ${num}, 'draft', 'manual')`)
  const rows = legs.map(([acct, amt, party], i) =>
    sql`(${org.orgId}, ${entry}, ${i + 1}, ${acct}, ${org.subsidiaryId}, ${amt}, 'CAD', ${amt}, '1', ${party}, ${(party !== null && (acct === org.accounts.ar || acct === org.accounts.ap)) as unknown as boolean}, ${num})`)
  await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item, memo) values ${sql.join(rows, sql`, `)}`)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
  return entry
}

async function applyLines(org: ScratchOrg, fromLine: string, toLine: string, amount: string, appliedOn: string): Promise<void> {
  await db.execute(sql`insert into applications (org_id, from_line_id, to_line_id, amount, source_amount, applied_on,
      source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
      settlement_rate, settlement_rate_source, settlement_rate_reference)
    values (${org.orgId}, ${fromLine}, ${toLine}, ${amount}, ${amount}, ${appliedOn}, ${amount}, 'CAD', ${amount}, 'CAD', 1, 'same_currency', 'AGING-PROBE')`)
}

async function lineId(entryId: string, accountId: string): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${entryId} and account_id = ${accountId}`)
  assert.ok(r.rows[0], 'expected the line to exist')
  return r.rows[0]!.id
}

/** July invoice 1000 settled by a July part-payment, a July credit memo application, and an August final payment. */
async function seedArScenario(): Promise<{ org: ScratchOrg }> {
  const org = await withBypassContext(() => createScratchOrg())
  await withBypassContext(async () => {
    const july = org.periodId
    const cal = (await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where id = ${july}`)).rows[0]!.id
    const aug = randomUUID()
    await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${aug}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${cal})`)

    const eInv = await postEntry(org, july, '2026-07-05', 'INV', [[org.accounts.ar, '1000.0000', org.customerId], [org.accounts.revenue, '-1000.0000', null]])
    await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, currency, fx_rate, subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance)
      values (${randomUUID()}, ${org.orgId}, 'customer_invoice', 'AGE-INV-1', '2026-07-05', '2026-07-05', '2026-07-15', 'CAD', '1', '1000.0000', '0.0000', '1000.0000', ${org.customerId}, 'posted', ${eInv}, ${july}, '1000.0000')`)

    // July part-payment 400, applied 07-20.
    const ePayJul = await postEntry(org, july, '2026-07-20', 'PAYJ', [[org.accounts.bank, '400.0000', null], [org.accounts.ar, '-400.0000', org.customerId]])
    await applyLines(org, await lineId(ePayJul, org.accounts.ar), await lineId(eInv, org.accounts.ar), '400.0000', '2026-07-20')

    // July credit memo 100, applied to the invoice 07-25.
    const eCm = await postEntry(org, july, '2026-07-22', 'CM', [[org.accounts.revenue, '100.0000', null], [org.accounts.ar, '-100.0000', org.customerId]])
    await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, currency, fx_rate, subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance)
      values (${randomUUID()}, ${org.orgId}, 'customer_credit', 'AGE-CM-1', '2026-07-22', '2026-07-22', '2026-07-22', 'CAD', '1', '100.0000', '0.0000', '100.0000', ${org.customerId}, 'posted', ${eCm}, ${july}, '100.0000')`)
    await applyLines(org, await lineId(eCm, org.accounts.ar), await lineId(eInv, org.accounts.ar), '100.0000', '2026-07-25')

    // August final payment 500, applied 08-05 — after the July as-of.
    const ePayAug = await postEntry(org, aug, '2026-08-05', 'PAYA', [[org.accounts.bank, '500.0000', null], [org.accounts.ar, '-500.0000', org.customerId]])
    await applyLines(org, await lineId(ePayAug, org.accounts.ar), await lineId(eInv, org.accounts.ar), '500.0000', '2026-08-05')
  })
  return { org }
}

test('AR aging as of July still shows the balance settled in August', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedArScenario()
  try {
    await withOrgContext(org.orgId, async () => {
      // July GL truth: 1000 − 400 − 100 = 500 on the receivable control.
      const gl = (await db.execute<{ bal: string }>(sql`select coalesce(sum(l.amount), 0)::text as bal from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed') and e.posting_date <= '2026-07-31' and e.book_id = ${org.bookId}
        where l.org_id = ${org.orgId} and l.account_id = ${org.accounts.ar}`)).rows[0]!.bal
      assert.equal(gl, '500.0000')

      const aging = await agingByParty('ar', '2026-07-31', undefined, org.orgId)
      assert.equal(aging.totals.total, '500.0000', 'July AR aging must tie the July control balance after an August settlement')
      // Empty buckets read the canonical ledger zero ('0.0000', as the totals
      // always have): the old grouped query returned SQL's integer-coalesced
      // '0' here, a formatting artifact of the query shape, not arithmetic.
      assert.deepEqual(
        aging.rows.map((r) => [r.partyName, r.current, r.b1, r.b2, r.b3, r.b4, r.total]),
        [['Acme Customer', '0.0000', '500.0000', '0.0000', '0.0000', '0.0000', '500.0000']],
      )

      const detail = await agingDetail('ar', '2026-07-31', undefined, org.orgId)
      assert.equal(detail.totals.total, '500.0000', 'aging detail must tie the summary')
      assert.equal(detail.rows.length, 1, 'only the invoice carries a July open balance; the settled credit memo drops out')

      // Sibling surfaces that already scope to the as-of date.
      const partners = await partnerBalances('receivable', org.orgId, '2026-07-31')
      assert.equal(partners.length, 1)
      assert.equal(partners[0]!.balance, '500.0000')
      const reg = await partyRegister('ar', { from: '2026-01-01', to: '2026-07-31', orgId: org.orgId })
      assert.equal(reg.parties.length, 1)
      assert.equal(reg.parties[0]!.closing, '500.0000')
      const stmt = await partnerStatement(org.customerId, org.orgId, { from: '2026-01-01', to: '2026-07-31', side: 'ar' })
      assert.equal(stmt.closing, '500.0000')
      assert.equal(stmt.aging.total, '500.0000', 'partner-statement footer must agree with its own closing')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('AP aging as of July still shows the bill paid in August', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const july = org.periodId
      const cal = (await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where id = ${july}`)).rows[0]!.id
      const aug = randomUUID()
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${aug}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${cal})`)
      const eBill = await postEntry(org, july, '2026-07-12', 'BILL', [[org.accounts.cogs, '300.0000', null], [org.accounts.ap, '-300.0000', org.vendorId]])
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, currency, fx_rate, subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance)
        values (${randomUUID()}, ${org.orgId}, 'vendor_bill', 'AGE-BILL-1', '2026-07-12', '2026-07-12', '2026-08-11', 'CAD', '1', '300.0000', '0.0000', '300.0000', ${org.vendorId}, 'posted', ${eBill}, ${july}, '300.0000')`)
      const ePay = await postEntry(org, aug, '2026-08-06', 'VPAY', [[org.accounts.ap, '300.0000', org.vendorId], [org.accounts.bank, '-300.0000', null]])
      await applyLines(org, await lineId(ePay, org.accounts.ap), await lineId(eBill, org.accounts.ap), '300.0000', '2026-08-06')
    })
    await withOrgContext(org.orgId, async () => {
      const aging = await agingByParty('ap', '2026-07-31', undefined, org.orgId)
      assert.equal(aging.totals.total, '300.0000', 'July AP aging must tie the July control balance after an August payment')
      const detail = await agingDetail('ap', '2026-07-31', undefined, org.orgId)
      assert.equal(detail.totals.total, '300.0000')
      // Current (not-yet-due) bucket: due 08-11 is after the as-of date.
      assert.equal(aging.totals.current, '300.0000')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('aging as of today still matches the live open balances', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedArScenario()
  try {
    await withOrgContext(org.orgId, async () => {
      // Everything settled in August: current aging is zero under either basis.
      const aging = await agingByParty('ar', '2026-08-31', undefined, org.orgId)
      assert.equal(aging.totals.total, '0.0000')
      assert.equal(aging.rows.length, 0)
      const detail = await agingDetail('ar', '2026-08-31', undefined, org.orgId)
      assert.equal(detail.totals.total, '0.0000')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
