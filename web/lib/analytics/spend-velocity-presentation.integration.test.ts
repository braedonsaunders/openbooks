import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

type VendorLeg = { vendor_id: string; vendor_name: string; func: string; total_amount: string; transaction_count: string }
const vendorCapture = { rows: [] as VendorLeg[] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.spend-velocity-vendor-test')] = vendorCapture
const queryModule = new URL('./query.ts', import.meta.url).href
const dialectModule = import.meta.resolve('drizzle-orm/pg-core')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './query' && context.parentURL?.endsWith('/analytics/spend-velocity-data.ts')) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
        import { analyticsQuery as read } from ${JSON.stringify(queryModule)};
        import { PgDialect } from ${JSON.stringify(dialectModule)};
        const dialect = new PgDialect();
        export async function analyticsQuery(query) {
          const result = await read(query);
          if (dialect.sqlToQuery(query).sql.includes('counts.transaction_count') &&
              dialect.sqlToQuery(query).sql.includes('vendor_id')) {
            globalThis[Symbol.for('openbooks.spend-velocity-vendor-test')].rows = result.rows;
          }
          return result;
        }
      `)}` }
    }
    // No request scope here: the money formatter resolves its locale through
    // request cookies, so serve an empty jar (anonymous caller, default locale).
    if (specifier === 'next/headers') return { shortCircuit: true, url: 'data:text/javascript,export function cookies() { return { get() { return undefined } } }' }
    return next(specifier, context)
  },
})
test.after(() => hooks.deregister())

const { sql } = await import('drizzle-orm')
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg, assertDedicatedFixtureDatabase } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { compareDecimal } = await import('@openbooks/engine/money/decimal')
const { spendVelocityData } = await import('./spend-velocity-data')
// The data layer pulls in web/lib/auth, whose request-org module registers
// its Next request-store RLS resolver at import time — after the runner's
// trusted test bypass. Outside a request that resolver denies everything,
// so scratch reads come back empty. Re-assert the bypass here, after every
// import, so this file sees its own fixtures.
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
installTrustedTestDatabaseBypass()

const D = '2026-07-14'
const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

async function seedTwoCurrencySpend(lineCount = 1) {
  await assertDedicatedFixtureDatabase()
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  // A genuine COGS-typed account: the scratch fixture types every P&L
  // account 'expense', which would hide a COGS-vs-OpEx mix-up.
  const cogsAccountId = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${cogsAccountId}, ${org.orgId}, '5001', 'True COGS', 'cogs', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    // CAD bill posts to an expense account; USD bill posts to the COGS
    // account. Both belong to the spend-document universe (235 CAD total).
    const bills = [
      ['BILL-CAD', org.subsidiaryId, org.vendorId, 'CAD', '100', '1', org.accounts.freight],
      ['BILL-USD', usSub, org.vendorId, 'USD', '100', '1', cogsAccountId],
    ] as const
    for (const [num, sub, party, cur, total, fx, accountId] of bills) {
      const docId = randomUUID()
      const entryId = randomUUID()
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', ${num}, ${party}, ${sub}, ${D}, ${D}, ${cur}, ${fx}, 'draft', ${total}, 0, ${total}, ${total})`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${sub}, ${party}, true, ${'-' + total}, ${cur}, ${'-' + total}, ${fx})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        select gen_random_uuid(), ${org.orgId}, ${entryId}, n + 1, ${accountId}, ${sub}, ${party}, false,
          ${total}::numeric / ${lineCount}, ${cur}, ${total}::numeric / ${lineCount}, ${fx}
        from generate_series(1, ${lineCount}::int) n`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId} where id=${docId}`)
    }
    // Genuine operating expense with NO spend document (e.g. depreciation):
    // a manual GL journal the spend-document universe never sees.
    const opexEntry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${opexEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'OPEX-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${randomUUID()}, ${org.orgId}, ${opexEntry}, 1, ${org.accounts.freight}, ${org.subsidiaryId}, '50', 'CAD', '50', 1),
             (${randomUUID()}, ${org.orgId}, ${opexEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '-50', 'CAD', '-50', 1)`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${opexEntry}`)
    // Commitments (document totals, no postings): CAD PO 100 + USD PO 100.
    for (const [num, sub, cur, total] of [['PO-CAD', org.subsidiaryId, 'CAD', '100'], ['PO-USD', usSub, 'USD', '100']] as const) {
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total)
        values (${randomUUID()}, ${org.orgId}, 'purchase_order', ${num}, ${org.vendorId}, ${sub}, ${D}, ${D}, ${cur}, 1, 'approved', ${total}, 0, ${total})`)
    }
    // Income lines (GL only) funding the OpEx ratio: CAD 470.
    const revEntry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${revEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'REV-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${randomUUID()}, ${org.orgId}, ${revEntry}, 1, ${org.accounts.revenue}, ${org.subsidiaryId}, '-470', 'CAD', '-470', 1),
             (${randomUUID()}, ${org.orgId}, ${revEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '470', 'CAD', '470', 1)`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${revEntry}`)
  })
  return org
}

/**
 * Spend velocity compares monthly series across accounts, vendors, and
 * commitment kinds: every leg must sit in the presentation currency or the
 * velocity math, detectors, and YoY trends compare unlike currencies. A USD
 * 100 bill in a USD subsidiary is 135 CAD of spend — in totals, series,
 * commitments, and prior windows alike.
 */
test('spend velocity translates every spend functional to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencySpend()
  try {
    await pinClock('2026-07-15', async () => {
      const data = await spendVelocityData(org.orgId, P, null)
      assert.equal(data.summary.totalSpend, "235.0000")
      assert.equal(data.summary.billsTotal, "235.0000")
      assert.equal(data.monthlyTrends.find((m) => m.month === '2026-07')?.totalAmount, "235.0000")
      assert.equal(data.commitmentCliff.summary.totalPO, '235.0000')
      // No fragmentation size cap is configured out of the box: the detector
      // reports itself unconfigured by name instead of scoring against a
      // currency-blind default.
      assert.equal(data.fragmentation.summary.configured, false)
      assert.match(data.fragmentation.summary.reason, /Configuration/)
      // No minimum base is configured out of the box either: the cliff's
      // growth figures report as not configured by name instead of scoring
      // without a floor.
      assert.equal(data.commitmentCliff.summary.configured, false)
      assert.match(data.commitmentCliff.summary.reason, /Configuration/)
      assert.equal(data.commitmentCliff.summary.poVelocity, null)
      assert.equal(data.commitmentCliff.summary.soVelocity, null)
      // The headline score silently omits both unconfigured detectors, so
      // the summary names them for the view's caveat.
      assert.deepEqual(data.summary.unconfiguredDetectors, ["fragmentation", "cliff"])
      // Revenue arrives as an exact decimal string.
      assert.equal(data.revenue.totalRevenue, '470.0000')
      // P&L operating expenses are the 100 CAD bill plus the 50 CAD manual
      // journal; the 135 CAD of COGS spend must not feed the "Operating
      // expenses … of revenue" ratio.
      assert.equal(data.revenue.opexRatio, 32)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Mid-year go-live: the first spend posts inside the current window while the
 * prior window predates cutover. Change-vs-prior is UNKNOWN (null) there —
 * a first period of spend must never read as +100% growth against no data.
 */
test('period comparison reports unknown change when the prior window has no history', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      const docId = randomUUID()
      const entryId = randomUUID()
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', 'BILL-FIRST', ${org.vendorId}, ${org.subsidiaryId}, ${D}, ${D}, 'CAD', 1, 'draft', 100, 0, 100, 100)`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'BILL-FIRST', ${D}, ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${org.vendorId}, true, '-100', 'CAD', '-100', 1),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, ${org.vendorId}, false, '100', 'CAD', '100', 1)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId} where id=${docId}`)
    })
    await pinClock('2026-07-15', async () => {
      const data = await spendVelocityData(org.orgId, P, null)
      const row = data.periodComparison.accounts.find((a) => Number(a.currentAmount) > 0)
      assert.ok(row, 'expected one spend row in the current window')
      assert.equal(row.priorAmount, "0")
      assert.equal(row.isNew, true)
      assert.equal(row.changePct, null)
      assert.equal(data.periodComparison.summary.priorTotal, "0.0000")
      assert.equal(data.periodComparison.summary.changePct, null)
      // With no prior-year bucket either, the trend change is unknown — never
      // a fabricated zero — and the spender change matches the comparison.
      const trend = data.monthlyTrends.find((m) => m.month === '2026-07')!
      assert.equal(trend.priorYearAmount, "0")
      assert.equal(trend.yoyChange, null)
      assert.equal(trend.velocity, null)
      assert.equal(data.expenseAnalysis.summary.expenseReportTotal, "0")
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('spend velocity fails closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencySpend()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await pinClock('2026-07-15', async () => {
      await assert.rejects(spendVelocityData(org.orgId, P, null), /no spot rate for USD/)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('vendor aggregation preserves per-line pricing, distinct documents, fresh names and entity scope across many lines', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencySpend(100)
  try {
    const history = async () => (await db.execute(sql`select * from journal_lines where org_id=${org.orgId} order by id`)).rows
    const before = await history()
    const reference = async (scope: ReadonlySet<string> | null) => {
      const ids = scope === null ? null : [...scope]
      const allowed = ids?.length ? sql.join(ids.map(id => sql`${id}::uuid`), sql`, `) : sql`null`
      return (await db.execute<VendorLeg>(sql`
        with spend as materialized (
          select d.party_id as vendor_id,
            (select p.display_name from parties p where p.id=d.party_id and p.org_id=d.org_id) as vendor_name,
            d.id as doc_id, l.amount, sub.base_currency as func
          from journal_lines l
          join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
          join documents d on d.id=e.source_document_id and d.org_id=e.org_id
          join accounts a on a.id=l.account_id and a.org_id=l.org_id
          left join subsidiaries sub on sub.id=l.subsidiary_id and sub.org_id=l.org_id
          where l.org_id=${org.orgId} and d.voided_at is null
            and e.book_id=${org.bookId} and e.status in ('posted','reversed')
            and d.kind in ('vendor_bill','vendor_credit','expense_report','check')
            and a.type in ('expense','expense_other','expense_deferred','cogs')
            and e.posting_date >= ${P.from} and e.posting_date <= ${P.to}
            and d.party_id is not null
            ${ids === null ? sql`` : sql`and l.subsidiary_id in (${allowed}) and d.subsidiary_id in (${allowed})`}
        ), counts as (
          select vendor_id, count(distinct doc_id) as transaction_count from spend group by vendor_id
        )
        select vendor_id, coalesce(vendor_name,'Unknown') as vendor_name, func,
          sum(amount) as total_amount, counts.transaction_count
        from spend join counts using(vendor_id)
        group by vendor_id,vendor_name,func,counts.transaction_count
      `)).rows
    }
    await pinClock('2026-07-15', async () => {
      const check = async (scope: ReadonlySet<string> | null, total: string, count: number) => {
        const expected = await reference(scope)
        vendorCapture.rows = []
        const data = await spendVelocityData(org.orgId, P, scope)
        assert.equal(vendorCapture.rows.length, expected.length)
        for (const row of expected) {
          const actual = vendorCapture.rows.find(value => value.vendor_id === row.vendor_id && value.func === row.func)
          assert.ok(actual)
          assert.equal(actual.vendor_name, row.vendor_name)
          assert.equal(compareDecimal(String(actual.total_amount), String(row.total_amount)), 0)
          assert.equal(Number(actual.transaction_count), Number(row.transaction_count))
        }
        assert.equal(data.summary.totalSpend, total)
        assert.equal(data.vendorVelocity.find(row => row.id === org.vendorId)?.transactionCount ?? 0, count)
        return data
      }
      const initial = await check(null, '235.0000', 2)
      assert.equal(initial.vendorVelocity.find(row => row.id === org.vendorId)?.totalSpend, '235.0000')
      await check(new Set([org.subsidiaryId]), '100.0000', 1)
      const otherSub = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id=${org.orgId} and base_currency='USD'`)).rows[0]!.id
      await check(new Set([otherSub]), '135.0000', 1)
      await check(new Set(), '0.0000', 0)
      await check(new Set([randomUUID()]), '0.0000', 0)
      await withBypass(() => db.execute(sql`update parties set display_name='Current vendor label' where id=${org.vendorId} and org_id=${org.orgId}`))
      const renamed = await check(null, '235.0000', 2)
      assert.equal(renamed.vendorVelocity.find(row => row.id === org.vendorId)?.name, 'Current vendor label')
    })
    assert.deepEqual(await history(), before, 'analytics must preserve posted journal history')
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})


test('a posted bill spanning accounts counts once in the bucket and once in each account', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      const docId = randomUUID(), entryId = randomUUID()
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', 'BILL-SPLIT', ${org.vendorId}, ${org.subsidiaryId}, ${D}, ${D}, 'CAD', 1, 'draft', 100, 0, 100, 100)`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'BILL-SPLIT', ${D}, ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${org.vendorId}, true, '-100', 'CAD', '-100', 1),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, ${org.vendorId}, false, '40', 'CAD', '40', 1),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 3, ${org.accounts.freight}, ${org.subsidiaryId}, ${org.vendorId}, false, '30', 'CAD', '30', 1),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 4, ${org.accounts.freight}, ${org.subsidiaryId}, ${org.vendorId}, false, '30', 'CAD', '30', 1)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId} where id=${docId}`)
    })
    await pinClock('2026-07-15', async () => {
      const data = await spendVelocityData(org.orgId, P, null)
      assert.equal(data.summary.totalSpend, '100.0000')
      assert.equal(data.monthlyTrends.find(row => row.month === '2026-07')?.transactionCount, 1)
      const accounts = data.accountVelocity.filter(row => row.id === org.accounts.cogs || row.id === org.accounts.freight)
      assert.equal(accounts.length, 2)
      assert.ok(accounts.every(row => row.transactionCount === 1))
      assert.equal(data.vendorVelocity.find(row => row.id === org.vendorId)?.transactionCount, 1)
    })
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})
