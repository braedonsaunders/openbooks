import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Live-Postgres regression: compliance exposure aggregates must be base
// currency. The matrix documents each vendor's open balance as base currency
// and the cockpit renders one blocked-exposure figure, but both summed
// document-currency open_balance with no fx_rate conversion — so a vendor
// owed 100 CAD plus 100 USD at 1.36 reported 200 instead of 236, understating
// the cash a blocked pay run would release.

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // Resolve this worktree's engine directly, even when node_modules is shared.
    if (specifier.startsWith('@openbooks/engine/')) {
      const engineRoot = new URL('../../engine/', import.meta.url)
      return {
        url: new URL(specifier.slice('@openbooks/engine/'.length), engineRoot).href,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})
// Query-suffixed URL keeps this import out of the module cache shared with
// sibling suites (a const URL is opaque to tsc, which would otherwise try to
// resolve the query).
const libUrl = './compliance.ts?exposure'
const { loadBlockedBills, loadComplianceMatrix, loadComplianceOverview } =
  (await import(libUrl)) as typeof import('./compliance.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { mulRate } = await import('@openbooks/engine/src/money/money.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

const DB = !!process.env.OPENBOOKS_DB_URL

type Org = Awaited<ReturnType<typeof createScratchOrg>>

async function seedBlockingPolicy(org: Org, actorId: string): Promise<void> {
  const classId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      update orgs
         set settings = settings || '{"features": {"subcontractorCompliance": true}}'::jsonb
       where id = ${org.orgId}`)
    await db.execute(sql`
      insert into compliance_classes
        (id, org_id, code, name, lien_waiver_enforcement, default_information_return,
         created_by, updated_by)
      values
        (${classId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC',
         ${actorId}, ${actorId})`)
    // The scratch vendor has no certificates, so this missing requirement
    // blocks every one of its bills at the pay run.
    await db.execute(sql`
      insert into compliance_requirements
        (org_id, code, name, category, class_id, enforcement, created_by, updated_by)
      values
        (${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', ${classId},
         'block_payment', ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
      values (${org.orgId}, ${org.vendorId}, ${classId}, ${actorId}, ${actorId})`)
  })
}

async function seedBill(
  org: Org,
  actorId: string,
  opts: { currency: string; txnAmount: string; fxRate: string },
): Promise<string> {
  const billId = randomUUID()
  const entryId = randomUUID()
  const date = org.date
  // Functional (base) leg amounts per the jl_fx_consistent invariant:
  // amount = txn_amount x fx_rate. Stored open balances stay in document
  // currency (migration 0100); readers that aggregate across documents must
  // convert through fx_rate themselves.
  const amount = mulRate(opts.txnAmount, opts.fxRate)
  const tag = `${opts.currency}-${opts.txnAmount}-${billId.slice(0, 8)}`
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate,
         subtotal, tax_total, total, created_by, updated_by)
      values
        (${billId}, ${org.orgId}, 'vendor_bill', 'approved',
         ${`EXPO-${tag}`}, ${org.subsidiaryId}, ${org.vendorId},
         ${date}, ${date}, ${opts.currency}, ${opts.fxRate},
         ${opts.txnAmount}, '0', ${opts.txnAmount}, ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, source_document_id, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`EXPO-${tag}`}, ${date}, ${org.periodId},
         'Exposure fixture', 'draft', ${billId}, 'document',
         ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount,
         currency, txn_amount, fx_rate, party_id, is_open_item, memo)
      values
        (${randomUUID()}, ${org.orgId}, ${entryId}, 1,
         ${org.accounts.cogs}, ${org.subsidiaryId}, ${amount},
         ${opts.currency}, ${opts.txnAmount}, ${opts.fxRate}, null, false, 'Exposure expense'),
        (${randomUUID()}, ${org.orgId}, ${entryId}, 2,
         ${org.accounts.ap}, ${org.subsidiaryId}, ${`-${amount}`},
         ${opts.currency}, ${`-${opts.txnAmount}`}, ${opts.fxRate}, ${org.vendorId}, true, 'Exposure payable')`)
    await db.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${actorId}
       where org_id = ${org.orgId} and id = ${entryId}`)
    // Posting stamps the rate and the open-balance trigger recomputes the
    // document-currency balance from the open AP leg.
    await db.execute(sql`
      update documents
         set status = 'posted', posted_entry_id = ${entryId},
             posting_period_id = ${org.periodId}, fx_rate = ${opts.fxRate}
       where org_id = ${org.orgId} and id = ${billId}`)
  })
  return billId
}

test(
  'compliance exposure aggregates convert foreign bills at their posted rate',
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Exposure reader', 'admin'))
      await seedBlockingPolicy(org, actorId)
      // 100 home-currency plus 100 USD at 1.36: base exposure 236, not 200.
      await seedBill(org, actorId, { currency: 'CAD', txnAmount: '100', fxRate: '1' })
      await seedBill(org, actorId, { currency: 'USD', txnAmount: '100', fxRate: '1.36' })

      const matrix = await withOrgContext(org.orgId, () => loadComplianceMatrix({ orgId: org.orgId }))
      const row = matrix.rows.find((r) => r.partyId === org.vendorId)
      assert.ok(row, 'the classified vendor appears in the matrix')
      assert.equal(
        Number(row.openBalance),
        236,
        `matrix open balance is base currency (got ${row.openBalance})`,
      )

      const blocked = await withOrgContext(org.orgId, () => loadBlockedBills(org.orgId))
      assert.equal(blocked.length, 2, 'both bills are evaluated')
      for (const bill of blocked) {
        assert.equal(bill.decision, 'blocked', 'the missing certificate blocks each bill')
      }

      const overview = await withOrgContext(org.orgId, () =>
        loadComplianceOverview(org.orgId, Number(org.date.slice(0, 4))),
      )
      assert.equal(
        Number(overview.blockedExposure),
        236,
        `blocked exposure is base currency (got ${overview.blockedExposure})`,
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)

// F-t03-008: the matrix column is labelled "Open payable" — the same metric
// the /ap dashboard, the aging and the control account read off the shared
// as-of open-items reader. SIM Meridian proved the matrix's own date-blind
// document-cache aggregate disagrees in BOTH directions at once: Talent read
// $67,235.41 on the dashboard against $50,532.54 on the matrix (a payment
// applied after the as-of zeroes the cached balance while the bill is still
// open as of the date), WeWork $31,148.65 against $39,963.25 (future-posted
// bills the as-of reader correctly excludes). One cause, both directions:
// the matrix must group the shared as-of item set, not the cache.
async function seedAsOfBill(
  org: Org,
  actorId: string,
  opts: { number: string; date: string; periodId: string; amount: string; dueDate: string },
): Promise<{ docId: string; lineId: string }> {
  const docId = randomUUID()
  const entryId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by, updated_by)
      values
        (${docId}, ${org.orgId}, 'vendor_bill', 'approved',
         ${opts.number}, ${org.subsidiaryId}, ${org.vendorId},
         ${opts.date}, 'CAD', '1', ${opts.amount}, '0', ${opts.amount}, ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, source_document_id, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${opts.number}, ${opts.date}, ${opts.periodId},
         'As-of fixture', 'draft', ${docId}, 'document', ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount,
         currency, txn_amount, fx_rate, party_id, is_open_item, due_date, memo)
      values
        (${randomUUID()}, ${org.orgId}, ${entryId}, 1,
         ${org.accounts.cogs}, ${org.subsidiaryId}, ${opts.amount},
         'CAD', ${opts.amount}, '1', null, false, null, 'As-of expense'),
        (${randomUUID()}, ${org.orgId}, ${entryId}, 2,
         ${org.accounts.ap}, ${org.subsidiaryId}, ${`-${opts.amount}`},
         'CAD', ${`-${opts.amount}`}, '1', ${org.vendorId}, true, ${opts.dueDate}, 'As-of payable')`)
    await db.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${actorId}
       where org_id = ${org.orgId} and id = ${entryId}`)
    await db.execute(sql`
      update documents
         set status = 'posted', posted_entry_id = ${entryId},
             posting_period_id = ${opts.periodId}
       where org_id = ${org.orgId} and id = ${docId}`)
  })
  const line = (
    await withBypassContext(() =>
      db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${entryId} and is_open_item`),
    )
  ).rows[0]!.id
  return { docId, lineId: line }
}

test(
  'matrix open payable follows the shared as-of reader past future postings and future payments',
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'As-of reader', 'admin'))
      await seedBlockingPolicy(org, actorId)
      const calendar = (
        await withBypassContext(() =>
          db.execute<{ fiscal_calendar_id: string }>(
            sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`,
          ),
        )
      ).rows[0]!.fiscal_calendar_id
      const augustPeriod = randomUUID()
      await withBypassContext(async () => {
        await db.execute(sql`insert into accounting_periods
          (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${augustPeriod}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${calendar})`)
      })
      // Bill A posts in July and is paid in full in August; bill B posts in
      // August and stays unpaid. As of July 31 only A is open.
      const billA = await seedAsOfBill(org, actorId, {
        number: 'ASOF-A',
        date: '2026-07-15',
        periodId: org.periodId,
        amount: '1000',
        dueDate: '2026-08-14',
      })
      await seedAsOfBill(org, actorId, {
        number: 'ASOF-B',
        date: '2026-08-10',
        periodId: augustPeriod,
        amount: '2500',
        dueDate: '2026-09-09',
      })
      await withBypassContext(async () => {
        const pay = randomUUID()
        await db.execute(sql`insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values (${pay}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'ASOF-PAY', '2026-08-10', ${augustPeriod}, 'pay', 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item)
          values (${org.orgId}, ${pay}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${org.vendorId}, '-1000', 'CAD', '-1000', '1', false),
                 (${org.orgId}, ${pay}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, ${org.vendorId}, '1000', 'CAD', '1000', '1', true)`)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${pay}`)
        const payLine = (
          await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${pay} and is_open_item`)
        ).rows[0]!.id
        await db.execute(sql`insert into applications
          (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
           source_transaction_currency, target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source, settlement_rate_reference)
          values (${org.orgId}, ${payLine}, ${billA.lineId}, '1000', '2026-08-10', '1000', '1000', 'CAD', '1000', 'CAD',
            '1', 'same_currency', 'ASOF-TEST')`)
      })

      const july = await withOrgContext(org.orgId, () =>
        loadComplianceMatrix({ orgId: org.orgId, asOf: '2026-07-31' }),
      )
      const julyRow = july.rows.find((r) => r.partyId === org.vendorId)
      assert.ok(julyRow, 'the classified vendor appears in the matrix')
      assert.equal(
        Number(julyRow.openBalance),
        1000,
        `matrix open payable is the as-of figure: July bill open, August bill not yet posted, August payment not yet applied (got ${julyRow.openBalance})`,
      )

      const august = await withOrgContext(org.orgId, () =>
        loadComplianceMatrix({ orgId: org.orgId, asOf: '2026-08-31' }),
      )
      const augustRow = august.rows.find((r) => r.partyId === org.vendorId)
      assert.ok(augustRow, 'the classified vendor appears in the matrix')
      assert.equal(
        Number(augustRow.openBalance),
        2500,
        `after the payment applies only the August bill stays open (got ${augustRow.openBalance})`,
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)
