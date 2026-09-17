import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const { createPaymentDocument, updateDraftPayment, postPaymentWithApplications } = await import('@openbooks/engine/src/payments.ts')
const { partnerStatement } = await import('./reports/registers.ts')
const { exportDataToCsv, partnerStatementExportData } = await import('./report-pdf.ts')

const t = (key: string) => key

/** Ledger 4dp rendering of a document total (JPY 10501 → 10501.0000). */
function atLedgerScale(total: string): string {
  return total.includes('.') ? total.padEnd(total.indexOf('.') + 5, '0') : `${total}.0000`
}

/**
 * d5 — the full ISO 4217 registry is only real if a newly covered currency
 * travels the whole chain at its own scale: invoice (document) → post
 * (ledger) → partial same-currency settlement (applications) → partner
 * statement (report) → CSV export (file). JPY (0dp) must never grow cents;
 * KWD (3dp) must never be truncated to cents.
 *
 * The first assertion ties the chain to the seeded registry: on a tenant
 * database from before migration 0157 these rows are absent and the chain
 * cannot start.
 */
// open = transaction-currency remainder (documents.open_balance basis);
// baseOpen = the same remainder translated at the document FX rate, which is
// the basis the AR register, statement closing, and aging footer report
// (journal_lines.amount is base-denominated by design). baseTotal is the
// invoice line's own translated debit on the same basis
// (JPY 10501 × 0.0091 = 95.5591; KWD 1000.005 × 3.6 = 3600.018).
for (const [currency, fxRate, total, paid, open, baseOpen, baseTotal] of [
  ['JPY', '0.0091', '10501', '5000', '5501.0000', '50.0591', '95.5591'],
  ['KWD', '3.6000', '1000.005', '400.002', '600.0030', '2160.0108', '3600.0180'],
] as const) {
  test(`${currency} travels document → posting → settlement → statement → export at its own scale`, { skip: !env.OPENBOOKS_DB_URL }, async () => {
    const scratch = await withBypass(() => createScratchOrg())
    try {
      const actor = await withBypass(() => createScratchUser(scratch.orgId, 'D5 chain', 'admin'))
      const seed = await withBypass(() => db.execute<{ code: string; minor_units: number }>(
        sql`select code, minor_units from currencies where code in ('JPY', 'KWD') order by code`,
      ))
      assert.deepEqual(
        seed.rows,
        [{ code: 'JPY', minor_units: 0 }, { code: 'KWD', minor_units: 3 }],
        'the seeded registry must carry the chain currencies at ISO scale (migration 0157)',
      )
      const invoiceId = await withBypass(async () => {
        const id = randomUUID()
        await db.execute(sql`insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, fx_rate, subtotal, tax_total, total, created_by)
          values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${`D5-${currency}`}, ${scratch.subsidiaryId},
            ${scratch.customerId}, ${scratch.date}, ${currency}, ${fxRate}, ${total}, '0', ${total}, ${actor})`)
        await db.execute(sql`insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
          values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, ${total}, ${total}, 0, ${total})`)
        await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
        return id
      })
      // Engine calls run under withBypassContext: importing the statement
      // reader below pulls in the web request-org resolver, which replaces the
      // preloaded trusted-test bypass and denies unscoped queries (bare calls
      // die with 42501). withBypassContext is context-only — no outer
      // transaction — so createPaymentDocument's ambient writes still commit
      // immediately and stay visible to updateDraftPayment's own connection
      // (wrapping in withBypass would stage them uncommitted and invisible).
      const entry = await withBypassContext(() => postDocument(invoiceId, {
        control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank },
      }))
      await withBypass(async () => {
        const legs = (await db.execute<{ bal: string }>(
          sql`select coalesce(sum(amount), 0)::text as bal from journal_lines where entry_id = ${entry}`,
        )).rows[0]!.bal
        assert.equal(legs, '0.0000', 'posting balances exactly')
        const balance = (await db.execute<{ open_balance: string }>(
          sql`select open_balance::text as open_balance from documents where id = ${invoiceId}`,
        )).rows[0]!.open_balance
        assert.equal(balance, atLedgerScale(total), 'invoice opens at its total')
      })
      const line = (await withBypass(() => db.execute<{ id: string }>(
        sql`select id from journal_lines where entry_id = ${entry} and is_open_item`,
      ))).rows[0]!.id
      const payment = await withBypassContext(() => createPaymentDocument({
        orgId: scratch.orgId, kind: 'customer_payment', createdBy: actor,
        partyId: scratch.customerId, bankAccountId: scratch.accounts.bank,
        subsidiaryId: scratch.subsidiaryId, documentDate: scratch.date,
        currency, fxRate,
      }))
      await withBypassContext(() => updateDraftPayment(payment.id, {
        bankAccountId: scratch.accounts.bank,
        allocations: [{
          openLineId: line, sourceTransactionAmount: paid, targetTransactionAmount: paid,
          settlementRate: '1', settlementRateSource: 'same_currency', settlementRateReference: 'D5-E2E',
        }],
      }, actor, scratch.orgId))
      await withBypass(() => db.execute(sql`update documents set status = 'approved', submitted_by = ${actor}, submitted_at = now() where id = ${payment.id}`))
      await withBypassContext(() => postPaymentWithApplications(payment.id, undefined, actor))
      await withBypass(async () => {
        const balances = (await db.execute<{ id: string; open_balance: string }>(
          sql`select id, open_balance::text as open_balance from documents where id in (${invoiceId}, ${payment.id})`,
        )).rows
        const byId = new Map(balances.map((b) => [b.id, b.open_balance]))
        assert.equal(byId.get(invoiceId), open, 'partial settlement leaves the exact remainder open')
        assert.equal(byId.get(payment.id), '0.0000', 'the payment itself is fully applied')
      })
      // The statement reader issues bare queries with explicit org predicates,
      // so it runs in the scratch org's scope (unscoped it sees zero rows and
      // every scale assert below reads undefined).
      const st = await withOrgContext(scratch.orgId, () => partnerStatement(scratch.customerId, scratch.orgId, {
        from: '2026-07-01', to: '2026-07-31', side: 'ar',
      }))
      assert.equal(st.opening, '0.0000')
      assert.equal(st.closing, baseOpen, 'statement closing ties the settled remainder at document FX')
      assert.equal(st.aging.total, baseOpen, 'aging footer agrees with the statement')
      const invoiceLine = st.lines.find((l) => l.docKind === 'customer_invoice')
      assert.ok(invoiceLine, 'statement carries the invoice line')
      assert.equal(invoiceLine.debit, baseTotal, 'invoice line carries the translated base debit')
      const csv = exportDataToCsv(partnerStatementExportData(st, t as never), {})
      assert.ok(csv.includes(baseOpen), `export carries the closing remainder ${baseOpen}`)
    } finally {
      await withBypass(() => dropScratchOrg(scratch.orgId))
    }
  })
}
