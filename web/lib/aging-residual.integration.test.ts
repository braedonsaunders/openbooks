import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * F-t08-004 / F-t08-006: the aging must tie its control account to the cent.
 * Documents are not the whole control: unapplied receipts, direct control
 * journals, and legacy partyless opening balances post control lines with no
 * invoice/credit document behind them, and settlement dust (a payment line
 * whose stored base differs from the applied amount by a cent) leaves GL
 * balances no open document explains. The aging folds those in as an
 * explicit per-party residual — the "(no party)" row when no party is
 * stamped — so the totals always tie the control. A clean subledger reads
 * exactly as before (no phantom rows).
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
const { agingByParty, agingDetail } = (await import(root + 'web/lib/reports/aging.ts')) as typeof import('./reports/aging')

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

const D = '2026-07-14'
const DUE = '2026-07-24'

async function postEntry(org: ScratchOrg, memo: string, legs: [string, string, string | null][]): Promise<string> {
  const entry = randomUUID()
  const num = `RES-${memo}-${entry.slice(0, 6)}`
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, ${D}, ${org.periodId}, ${num}, 'draft', 'manual')`)
  const rows = legs.map(([acct, amt, party], i) =>
    sql`(${org.orgId}, ${entry}, ${i + 1}, ${acct}, ${org.subsidiaryId}, ${amt}, 'CAD', ${amt}, '1', ${party}, ${(party !== null && (acct === org.accounts.ar || acct === org.accounts.ap)) as unknown as boolean}, ${num})`)
  await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item, memo) values ${sql.join(rows, sql`, `)}`)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
  return entry
}

async function lineId(entryId: string, accountId: string): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${entryId} and account_id = ${accountId}`)
  assert.ok(r.rows[0], 'expected the line to exist')
  return r.rows[0]!.id
}

async function postInvoice(org: ScratchOrg, num: string, amount: string): Promise<string> {
  const entry = await postEntry(org, num, [[org.accounts.ar, amount, org.customerId], [org.accounts.revenue, `-${amount}`, null]])
  await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, currency, fx_rate, subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance)
    values (${randomUUID()}, ${org.orgId}, 'customer_invoice', ${num}, ${D}, ${D}, ${DUE}, 'CAD', '1', ${amount}, '0.0000', ${amount}, ${org.customerId}, 'posted', ${entry}, ${org.periodId}, ${amount})`)
  return entry
}

/** Presented-control truth in the residual's own scope: all books, control type, line dims. */
async function controlBalance(org: ScratchOrg, type: 'asset_receivable' | 'liability_payable', asOf: string): Promise<string> {
  const r = await db.execute<{ bal: string }>(sql`select coalesce(sum(l.amount), 0)::text as bal from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
   where l.org_id = ${org.orgId} and a.type = ${type} and e.posting_date <= ${asOf}`)
  return r.rows[0]!.bal
}

test('partyless control balances surface as an explicit row and tie the control (F-t08-006)', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      await postInvoice(org, 'RES-INV-1', '1000.0000')
      // A direct control journal with no party and no document (the JE-00001 shape).
      await postEntry(org, 'NOPARTY', [[org.accounts.ar, '250.0000', null], [org.accounts.revenue, '-250.0000', null]])
    })
    await withOrgContext(org.orgId, async () => {
      const gl = await controlBalance(org, 'asset_receivable', D)
      assert.equal(gl, '1250.0000')
      const aging = await agingByParty('ar', D, undefined, org.orgId)
      assert.equal(aging.totals.total, gl, 'aging total ties the AR control with partyless lines present')
      const stray = aging.rows.find((row) => row.partyId === null)
      assert.ok(stray, 'partyless balance gets its own row')
      assert.equal(stray.partyName, null, 'the row renders through the existing (no party) label')
      assert.equal(stray.current, '250.0000', 'undated balances sit in current')
      assert.equal(stray.total, '250.0000')
      const customer = aging.rows.find((row) => row.partyId === org.customerId)
      assert.equal(customer?.total, '1000.0000', 'documented balances are untouched by the residual')
      // The detail view lists open items only: documentless balances stay out.
      const detail = await agingDetail('ar', D, undefined, org.orgId)
      assert.equal(detail.totals.total, '1000.0000')
      assert.ok(detail.rows.every((row) => row.partyId !== null))
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('settlement dust lands on the right party and the total still ties (F-t08-004)', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const eInv = await postInvoice(org, 'RES-INV-2', '100.0000')
      // A 1c overpayment: the payment line posts 100.01 base while 100.00 applies.
      const ePay = await postEntry(org, 'OVERPAY', [[org.accounts.bank, '100.0100', null], [org.accounts.ar, '-100.0100', org.customerId]])
      await db.execute(sql`insert into applications (org_id, from_line_id, to_line_id, amount, source_amount, applied_on,
          source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
          settlement_rate, settlement_rate_source, settlement_rate_reference)
        values (${org.orgId}, ${await lineId(ePay, org.accounts.ar)}, ${await lineId(eInv, org.accounts.ar)},
          '100.0000', '100.0000', ${D}, '100.0000', 'CAD', '100.0000', 'CAD', 1, 'same_currency', 'RES-PROBE')`)
    })
    await withOrgContext(org.orgId, async () => {
      const gl = await controlBalance(org, 'asset_receivable', D)
      assert.equal(gl, '-0.0100', 'the control carries the 1c overpayment')
      const aging = await agingByParty('ar', D, undefined, org.orgId)
      assert.equal(aging.totals.total, gl, 'aging ties the control to the cent')
      const customer = aging.rows.find((row) => row.partyId === org.customerId)
      assert.ok(customer, 'the dust attributes to the customer, not to (no party)')
      assert.equal(customer.partyName, 'Acme Customer')
      assert.equal(customer.total, '-0.0100')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('a clean subledger reads exactly as before: no residual rows (F-t08-004/006)', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      await postInvoice(org, 'RES-INV-3', '500.0000')
    })
    await withOrgContext(org.orgId, async () => {
      const aging = await agingByParty('ar', D, undefined, org.orgId)
      assert.equal(aging.totals.total, '500.0000')
      assert.ok(aging.rows.every((row) => row.partyId !== null), 'no (no party) row on a tied book')
      assert.deepEqual(
        aging.rows.map((r) => [r.partyName, r.current, r.total]),
        [['Acme Customer', '500.0000', '500.0000']],
      )
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('AP residual presents credit-normal control positive and names the vendor (F-t08-006)', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const eBill = await postEntry(org, 'BILL', [[org.accounts.cogs, '300.0000', null], [org.accounts.ap, '-300.0000', org.vendorId]])
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, currency, fx_rate, subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance)
        values (${randomUUID()}, ${org.orgId}, 'vendor_bill', 'RES-BILL-1', ${D}, ${D}, ${DUE}, 'CAD', '1', '300.0000', '0.0000', '300.0000', ${org.vendorId}, 'posted', ${eBill}, ${org.periodId}, '300.0000')`)
      // A partyless AP top-up with no document.
      await postEntry(org, 'APTOP', [[org.accounts.cogs, '75.0000', null], [org.accounts.ap, '-75.0000', null]])
    })
    await withOrgContext(org.orgId, async () => {
      const gl = await controlBalance(org, 'liability_payable', D)
      assert.equal(gl, '-375.0000')
      const aging = await agingByParty('ap', D, undefined, org.orgId)
      assert.equal(aging.totals.total, '375.0000', 'AP aging presents the control positive and ties it')
      const stray = aging.rows.find((row) => row.partyId === null)
      assert.ok(stray, 'partyless AP balance gets its own row')
      assert.equal(stray.current, '75.0000')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
