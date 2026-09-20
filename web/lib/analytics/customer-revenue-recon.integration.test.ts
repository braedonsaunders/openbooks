import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { requestDocumentVoid } = await import('@openbooks/engine/src/ledger/document-void.ts')
const { runRevenueRecognition, cancelRevenueRecognitionForInvoice } = await import('@openbooks/engine/src/revenue/recognition.ts')
const { customerData } = await import('./customer-data')
const { profitAndLoss } = await import('../reports/statements')

const DB = !!process.env.OPENBOOKS_DB_URL
const JULY = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

type Org = Awaited<ReturnType<typeof createScratchOrg>>

async function postSale(
  org: Org,
  actor: string,
  opts: {
    kind: 'customer_invoice' | 'customer_credit'
    partyId: string
    amount: string
    taxCodeId?: string
    taxAmount?: string
    itemId?: string
    date?: string
  },
): Promise<string> {
  const id = randomUUID()
  const lineId = randomUUID()
  const tax = opts.taxAmount ?? '0'
  const date = opts.date ?? org.date
  const total = (Number(opts.amount) + Number(tax)).toFixed(4)
  await withBypass(async () => {
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
       posting_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${id}, ${org.orgId}, ${opts.kind}, 'draft', ${id}, ${org.subsidiaryId},
        ${opts.partyId}, ${date}, ${date}, 'CAD', '1', ${opts.amount}, ${tax}, ${total}, ${actor})`)
    await db.execute(sql`insert into document_lines
      (id, org_id, document_id, line_number, account_id, item_id, quantity, unit_price,
       amount, tax_amount, tax_input_amount, tax_code_id)
      values (${lineId}, ${org.orgId}, ${id}, 1, ${org.accounts.revenue}, ${opts.itemId ?? null},
        '1', ${opts.amount}, ${opts.amount}, ${tax}, ${opts.amount}, ${opts.taxCodeId ?? null})`)
    if (opts.taxCodeId) {
      await db.execute(sql`insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, withholding_account_id, overridden)
        values (${org.orgId}, ${lineId}, ${opts.taxCodeId}, 1, '10', ${opts.amount}, ${tax},
          ${tax}, '0.0000', 'standard', false, false, 2, ${org.accounts.taxOutput}, null, null, false)`)
    }
    await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
  })
  const control = { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank }
  // Explicit bypass: importing the P&L reader pulls web request-org, which
  // replaces the process-wide test bypass — engine writes need it restated.
  await withBypass(() => postDocument(id, { control }))
  return id
}

/**
 * Customer-intelligence revenue is RECOGNIZED (ledger income postings, the P&L
 * universe), invoiced stays alongside as the reconciling column, and the recon
 * bridge explains the gap: invoiced − recognized =
 * tax + credits + (timingDeferred − timingRecognized) + voids + other.
 *
 * Five customers pin the bridge stories plus the residual — taxed invoice with
 * a partial credit, deferred subscription recognized in-period, cross-period
 * document void, party-tagged manual journal, and a cross-period recognition
 * cancellation (f6's route; the mirror attributes through the schedule
 * back-link) — and the org total ties to the P&L resolver in both months
 * (the unification proof — one definition of revenue, read by both surfaces).
 */
test('customer revenue reconciles invoiced billings to ledger recognized revenue', { skip: !DB }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Recon Controller', 'admin'))
    const [custA, custB, custC, custD, custE] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    await withBypass(async () => {
      for (const [id, name] of [[custA, 'Taxed'], [custB, 'Deferred'], [custC, 'Voided'], [custD, 'Manual'], [custE, 'Cancelled']] as const) {
        await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${id}, ${scratch.orgId}, 'customer', ${name}, true, '{}'::jsonb)`)
      }
      // A second open period so the void mirror lands in a later period than
      // its invoice (the cross-period shape the recon voids row must explain).
      const cal = (await db.execute<{ id: string }>(
        sql`select fiscal_calendar_id as id from accounting_periods where org_id = ${scratch.orgId} limit 1`)).rows[0]!.id
      await db.execute(sql`insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${scratch.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, ${cal})`)
      await db.execute(sql`insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${scratch.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${cal})`)
    })

    // A: plain 1000 + taxed 500/50 invoice, partial 200/20 credit memo.
    await postSale(scratch, actor, { kind: 'customer_invoice', partyId: custA, amount: '1000' })
    const taxCode = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
        values (${taxCode}, ${scratch.orgId}, 'GST-STD', 'Standard GST', 'both', 'standard',
          ${scratch.accounts.taxOutput}, ${scratch.accounts.taxInput}, true)`)
    })
    await postSale(scratch, actor, { kind: 'customer_invoice', partyId: custA, amount: '500', taxCodeId: taxCode, taxAmount: '50' })
    await postSale(scratch, actor, { kind: 'customer_credit', partyId: custA, amount: '200', taxCodeId: taxCode, taxAmount: '20' })

    // B: 1200 deferred subscription, fully recognized in-period (single-period
    // rule keeps the schedule inside July; the timing legs stay nonzero gross).
    await withBypass(async () => {
      await db.execute(sql`update recognition_rules set recognition_periods = 1
        where org_id = ${scratch.orgId} and id = ${scratch.recognitionRuleId}`)
    })
    await postSale(scratch, actor, { kind: 'customer_invoice', partyId: custB, amount: '1200', itemId: scratch.items.service })
    const eJul = await postSale(scratch, actor, { kind: 'customer_invoice', partyId: custE, amount: '600', itemId: scratch.items.service })
    await withBypass(() => runRevenueRecognition(scratch.orgId, '2026-07-31', actor))

    // C: June 300 invoice voided into July, plus a small July invoice so the
    // customer stays in the billing population.
    const voided = await postSale(scratch, actor, { kind: 'customer_invoice', partyId: custC, amount: '300', date: '2026-06-10' })
    await withBypass(() => requestDocumentVoid({ documentId: voided, orgId: scratch.orgId, actorId: actor, reason: 'Recon void', reversalDate: '2026-07-20', source: 'api' }))
    await postSale(scratch, actor, { kind: 'customer_invoice', partyId: custC, amount: '50' })

    // D: July 10 invoice plus a party-tagged manual income journal (the path
    // outside every named bucket — the residual must catch exactly it).
    await postSale(scratch, actor, { kind: 'customer_invoice', partyId: custD, amount: '10' })
    await withBypass(async () => {
      const doc = randomUUID()
      const entry = randomUUID()
      await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, document_date, posting_date,
          party_id, subsidiary_id, currency, subtotal, tax_total, total)
        values (${doc}, ${scratch.orgId}, 'journal', 'draft', ${doc}, ${scratch.date}, ${scratch.date},
          null, ${scratch.subsidiaryId}, 'CAD', '75', '0', '75')`)
      await db.execute(sql`insert into journal_entries(id, org_id, book_id, subsidiary_id, entry_number,
          posting_date, period_id, status, origin, source_document_id)
        values (${entry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, ${entry},
          ${scratch.date}, ${scratch.periodId}, 'draft', 'manual', ${doc})`)
      await db.execute(sql`insert into journal_lines(org_id, entry_id, line_number, account_id, subsidiary_id,
          party_id, amount, currency, txn_amount, fx_rate)
        values (${scratch.orgId}, ${entry}, 1, ${scratch.accounts.revenue}, ${scratch.subsidiaryId},
            ${custD}, '-75', 'CAD', '-75', 1),
          (${scratch.orgId}, ${entry}, 2, ${scratch.accounts.bank}, ${scratch.subsidiaryId},
            null, '75', 'CAD', '75', 1)`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
      await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${entry},
          posting_period_id = ${scratch.periodId} where id = ${doc}`)
    })

    // E: 600 deferred subscription recognized in July, then cancelled in August
    // (f6's route flips the July posting to reversed and mirrors in August).
    // A small August invoice keeps E in the August billing population.
    await postSale(scratch, actor, { kind: 'customer_invoice', partyId: custE, amount: '10', date: '2026-08-05' })
    await withBypass(() => cancelRevenueRecognitionForInvoice({ documentId: eJul, orgId: scratch.orgId, actorId: actor, reason: 'Recon cancel test', reversalDate: '2026-08-15' }))

    // Reads through web readers run inside withOrgContext: importing a web
    // reader replaces the test bypass, so an unscoped read silently returns
    // zero rows. Seeds above run under withBypass; engine posts need neither.
    const { data, pnl } = await withOrgContext(scratch.orgId, async () => ({
      data: await customerData(JULY, scratch.orgId, null),
      pnl: await profitAndLoss('2026-07-01', '2026-07-31', undefined, scratch.orgId),
    }))
    const byName = new Map(data.rows.map((r) => [r.name, r]))
    const close = (actual: number, expected: number, what: string) =>
      assert.ok(Math.abs(actual - expected) < 0.01, `${what}: ${actual} ≈ ${expected}`)

    // The bridge identity holds per customer: nothing unexplained, no plug.
    for (const row of data.rows) {
      const b = row.recon.tax + row.recon.credits
        + (row.recon.timingDeferred - row.recon.timingRecognized) + row.recon.voids + row.recon.other
      close(row.invoicedRevenue - row.revenue, b, `${row.name} bridge`)
    }

    const a = byName.get('Taxed')!
    close(a.invoicedRevenue, 1550, 'A invoiced')
    close(a.revenue, 1300, 'A recognized')
    close(a.recon.tax, 50, 'A tax')
    close(a.recon.credits, 200, 'A credits')
    close(a.recon.other, 0, 'A other')

    const b = byName.get('Deferred')!
    close(b.invoicedRevenue, 1200, 'B invoiced')
    close(b.revenue, 1200, 'B recognized')
    close(b.recon.timingDeferred, 1200, 'B parked')
    close(b.recon.timingRecognized, 1200, 'B scheduled')
    close(b.recon.other, 0, 'B other')

    const c = byName.get('Voided')!
    close(c.invoicedRevenue, 50, 'C invoiced excludes the voided doc')
    close(c.revenue, -250, 'C recognized nets the mirror')
    close(c.recon.voids, 300, 'C voids')
    close(c.recon.other, 0, 'C other')

    const d = byName.get('Manual')!
    close(d.invoicedRevenue, 10, 'D invoiced')
    close(d.revenue, 85, 'D recognized includes the manual journal')
    close(d.recon.other, -75, 'D residual catches the manual income')

    // E is absent in July: f6's cancellation also voids the invoice, so the
    // voided document leaves the billing population entirely (same exclusion
    // customer C pins). The whole cancellation story lands in August.
    assert.ok(!byName.has('Cancelled'), 'E voided out of July')

    // Unification: CI recognized total ties to the P&L resolver, modulo the
    // known population edge F-p2-002 — E's reversed July posting (+600 in the
    // P&L universe) has no CI row because the voided invoice left the
    // doc-gated population. Pinned as E's seeded constant, not derived: any
    // other gap fails loudly instead of hiding in a plug.
    close(Number(pnl.revenue) - data.kpis.totalRevenue, 600, 'July gap is exactly E unattributed (F-p2-002)')
    close(data.kpis.totalInvoiced, 1550 + 1200 + 50 + 10, 'CI invoiced total')

    // E in August: the recognition mirror (attributed through the schedule
    // back-link — those legs carry no party) explains the whole gap. The
    // invoice void mirror carries no income legs (the invoice was parked),
    // so recognition timing is the entire story.
    const AUG = { from: '2026-08-01', to: '2026-08-31', label: 'August 2026' }
    const { aug, augPnl } = await withOrgContext(scratch.orgId, async () => ({
      aug: await customerData(AUG, scratch.orgId, null),
      augPnl: await profitAndLoss('2026-08-01', '2026-08-31', undefined, scratch.orgId),
    }))
    assert.equal(aug.rows.length, 1, 'only E billed in August')
    const ea = aug.rows[0]!
    const eb = ea.recon.tax + ea.recon.credits
      + (ea.recon.timingDeferred - ea.recon.timingRecognized) + ea.recon.voids + ea.recon.other
    close(ea.invoicedRevenue - ea.revenue, eb, 'E August bridge')
    close(ea.invoicedRevenue, 10, 'E August invoiced')
    close(ea.revenue, -590, 'E August recognized nets the mirror')
    close(ea.recon.voids, 600, 'E August voids (mirror attributed)')
    close(ea.recon.other, 0, 'E August other')
    close(aug.kpis.totalRevenue, Number(augPnl.revenue), 'August CI ties to P&L')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
