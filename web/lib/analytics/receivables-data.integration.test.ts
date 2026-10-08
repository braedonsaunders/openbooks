import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/platform/database'
import { postDocument } from '@openbooks/engine/documents'
import { add, normalizeMoney } from '@openbooks/engine/money'
import { createScratchOrg, createScratchUser, dropScratchOrg, assertDedicatedFixtureDatabase } from '@openbooks/engine/src/testing/fixtures.ts'
import type { Authz } from '../authz'
import { openItems } from '../cash/open-items'
import { MissingExchangeRateError } from '../fx-presentation'
import { receivablesData } from './receivables-data'
import { receivablesIntelligenceData } from './receivables-intelligence-data'
import { withAnalyticsRead } from './read-context'

const AS_OF = '2026-07-31'
type Org = Awaited<ReturnType<typeof createScratchOrg>>

async function postReceivable(org: Org, actor: string, input: {
  amount: string; due: string | null; party?: string; subsidiary?: string; currency?: string; credit?: boolean; receipt?: boolean
}) {
  const id = randomUUID()
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, ${input.receipt ? 'customer_payment' : input.credit ? 'customer_credit' : 'customer_invoice'}, 'draft', ${id},
      ${input.subsidiary ?? org.subsidiaryId}, ${input.party ?? org.customerId}, ${org.date}, ${input.due},
      ${input.currency ?? 'CAD'}, 1, ${input.amount}, 0, ${input.amount}, ${actor})`)
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${input.receipt ? org.accounts.bank : org.accounts.revenue}, 1, ${input.amount}, ${input.amount}, 0, ${input.amount})`)
  const approved = await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${id} returning id`)
  assert.equal(approved.rows.length, 1, 'the fixture document must reach its approved state before posting')
  return await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })
}

async function withFixture(action: (org: Org, actor: string) => Promise<void>) {
  // Native resource identity guard runs before tenant creation or fixture writes.
  await assertDedicatedFixtureDatabase()
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Receivables Controller', 'admin')
    await action(org, actor)
  } finally { await dropScratchOrg(org.orgId) }
}

/** Imported historical control lines may have no customer identity. They
 * remain real receivables but cannot be treated as one concentrated customer. */
async function unassignedReceivable(org: Org) {
  const document = randomUUID(), entry = randomUUID()
  await db.execute(sql`insert into documents
    (id, org_id, kind, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total)
    values (${document}, ${org.orgId}, 'customer_invoice', ${document}, ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 1, 1000, 0, 1000)`)
  await db.execute(sql`insert into journal_entries
    (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entry}, ${org.date}, ${org.periodId}, 'draft', 'manual', ${document})`)
  await db.execute(sql`insert into journal_lines
    (org_id, entry_id, line_number, account_id, subsidiary_id, is_open_item, amount, currency, txn_amount, fx_rate)
    values (${org.orgId}, ${entry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, true, 1000, 'CAD', 1000, 1),
           (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, false, -1000, 'CAD', -1000, 1)`)
  const posted = await db.execute(sql`update journal_entries set status = 'posted', posted_at = now()
    where org_id = ${org.orgId} and id = ${entry} returning id`)
  assert.equal(posted.rows.length, 1)
  const linked = await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${entry}, posting_period_id = ${org.periodId}
    where org_id = ${org.orgId} and id = ${document} returning id`)
  assert.equal(linked.rows.length, 1)
}

test('receivables totals reconcile to native open items with exact credits, aging and empty legal-entity scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withFixture(async (org, actor) => {
    await withBypassContext(async () => {
      await postReceivable(org, actor, { amount: '100.0001', due: '2026-05-02' }) // 90 days
      await postReceivable(org, actor, { amount: '20.0000', due: '2026-07-01', credit: true })
      await postReceivable(org, actor, { amount: '10.0000', due: null })
      await postReceivable(org, actor, { amount: '50.0000', due: '2026-08-07' })
    })
    await withOrgContext(org.orgId, async () => {
      const data = await receivablesData(org.orgId, AS_OF, null)
      const items = await openItems(org.orgId, 'ar', AS_OF)
      assert.equal(data.summary.outstanding, items.reduce((total, item) => add(total, item.remaining), '0.0000'))
      assert.equal(data.summary.outstanding, '140.0001')
      assert.equal(data.summary.gross, '160.0001')
      assert.equal(data.summary.credits, '20.0000')
      assert.equal(data.summary.overdue, '110.0001', 'credits must not erase overdue collectible balances')
      assert.equal(data.summary.severe, '100.0001', 'the 90th day belongs in the 90+ cohort')
      assert.equal(data.summary.missingTerms, '10.0000')
      assert.equal(data.summary.maturity[1]?.gross, '50.0000', 'seven-day contractual maturity includes the seventh day')
      assert.equal(data.summary.aging.reduce((total, row) => add(total, row.net), '0.0000'), data.summary.outstanding)
      assert.equal(data.summary.maturity.reduce((total, row) => add(total, row.net), '0.0000'), data.summary.outstanding)
      assert.equal(data.summary.documents, 4)
      const restricted = await receivablesData(org.orgId, AS_OF, new Set())
      assert.equal(restricted.summary.outstanding, '0.0000')
      assert.equal(restricted.summary.documents, 0)
      assert.deepEqual(restricted.customers, [])
    })
  })
})

test('summary cards omit customer details and ranked customer projections retain complete population totals', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withFixture(async (org, actor) => {
    await withBypassContext(async () => {
      for (let index = 0; index < 15; index++) {
        const id = randomUUID()
        await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${id}, ${org.orgId}, 'customer', ${`Customer ${index + 1}`}, true, '{}'::jsonb)`)
        await postReceivable(org, actor, { amount: '100.0000', due: '2026-07-01', party: id })
      }
      await unassignedReceivable(org)
    })
    const authz = { user: { orgId: org.orgId, id: actor }, permissions: new Set(['reports.read', 'ar.read']), allowedSubsidiaryIds: null } as Authz
    const context = { authz, slug: 'receivables-intelligence', locale: 'en', revision: randomUUID(), observedAt: Date.now() }
    await withOrgContext(org.orgId, async () => {
      const summary = await withAnalyticsRead({ ...context, projection: 'summary', tab: '' }, () => receivablesData(org.orgId, AS_OF, null))
      assert.deepEqual(summary.customers, [])
      const customers = await withAnalyticsRead({ ...context, projection: 'tab', tab: 'customers' }, () => receivablesData(org.orgId, AS_OF, null))
      assert.deepEqual(customers.summary, summary.summary, 'the card and selected tab must reuse the complete authoritative metric projection')
      assert.equal(customers.summary.customers, 15)
      assert.equal(customers.summary.documents, 16)
      assert.equal(customers.summary.outstanding, '2500.0000')
      assert.equal(customers.summary.top5Share, '0.2000', 'five named customers owe 500 of 2500; unassigned balances must not become a fictitious large customer')
      assert.equal(customers.customers.length, 12, 'only the ranked customer evidence is bounded')
      assert.equal(customers.customers.find((customer) => customer.id === null)?.gross, '1000.0000', 'unassigned exposure must remain visible in the evidence')
    })
  })
})

test('foreign-functional receivables round each line before grouping and refuse missing closing rates by name', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withFixture(async (org, actor) => {
    const subsidiary = randomUUID()
    await withBypassContext(async () => {
      // Global currency identity is shared reference data; an identical existing code is benign.
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2) on conflict (code) do nothing`)
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${subsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Foreign entity', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'USD', 'CAD', ${AS_OF}, 'spot', '1.35', 'manual')`)
      await postReceivable(org, actor, { amount: '100.0001', due: '2026-07-01', subsidiary, currency: 'USD' })
      await postReceivable(org, actor, { amount: '100.0001', due: '2026-07-01', subsidiary, currency: 'USD' })
    })
    await withOrgContext(org.orgId, async () => {
      const result = await receivablesData(org.orgId, AS_OF, null)
      const items = await openItems(org.orgId, 'ar', AS_OF)
      assert.equal(result.summary.outstanding, '270.0002', 'per-line rounding must agree with the native cash reader')
      assert.equal(result.summary.outstanding, normalizeMoney(items.reduce((total, item) => add(total, item.remaining), '0.0000')))
      assert.equal((await receivablesData(org.orgId, AS_OF, new Set([org.subsidiaryId]))).summary.outstanding, '0.0000')
    })
    await withBypassContext(async () => {
      const removed = await db.execute(sql`delete from fx_rates where org_id = ${org.orgId} returning 1`)
      assert.ok(removed.rows.length > 0)
    })
    await withOrgContext(org.orgId, () => assert.rejects(receivablesData(org.orgId, AS_OF, null), (error: unknown) => {
      assert.ok(error instanceof MissingExchangeRateError)
      assert.deepEqual(error.funcs, ['USD'])
      assert.match(error.message, /USD→CAD/)
      assert.match(error.message, /Setup → Exchange Rates/)
      return true
    }))
  })
})


test('collection portfolio uses contractual dates, exact cash recovery and bounded server-side search', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withFixture(async (org, actor) => {
    let invoiceLine = '', receiptLine = '', creditLine = ''
    await withBypassContext(async () => {
      const invoice = await postReceivable(org, actor, { amount: '100.0001', due: '2026-05-01' })
      const receipt = await postReceivable(org, actor, { amount: '40.0000', due: null, receipt: true })
      const credit = await postReceivable(org, actor, { amount: '20.0000', due: null, credit: true })
      const openLine = async (entry: string) => (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${entry} and is_open_item`)).rows[0]!.id
      invoiceLine = await openLine(invoice); receiptLine = await openLine(receipt); creditLine = await openLine(credit)
      for (const [line, amount, date] of [[receiptLine, '40.0000', '2026-07-20'], [creditLine, '20.0000', '2026-07-21']] as const) {
        await db.execute(sql`insert into applications
          (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount, source_transaction_currency,
           target_transaction_amount, target_transaction_currency, settlement_rate, settlement_rate_source, settlement_rate_reference)
          values (${org.orgId}, ${line}, ${invoiceLine}, ${amount}, ${date}, ${amount}, ${amount}, 'CAD', ${amount}, 'CAD', 1, 'same_currency', 'Receivables cash and credit evidence')`)
      }
      await postReceivable(org, actor, { amount: '10.0000', due: null })
    })
    await withOrgContext(org.orgId, async () => {
      const result = await receivablesIntelligenceData(org.orgId, '2026-07-16', AS_OF, null)
      assert.equal(result.summary.overdue, '40.0001', 'undated receivables must not become contractually late')
      assert.equal(result.summary.missingTerms, '10.0000')
      assert.equal(result.summary.opening, '100.0001')
      assert.equal(result.summary.recovered, '40.0000', 'credit applications are not cash recovered')
      assert.equal(result.summary.remaining, '40.0001')
      assert.equal(result.summary.otherChange, '20.0000', 'noncash reductions remain a separate bridge component')
      assert.notEqual(result.summary.onTimeShare, null, 'late cash has an eligible denominator')
      assert.equal(Number(result.summary.onTimeShare), 0, 'an eligible window with only late receipts is zero, not unknown')
      assert.equal(result.customers[0]!.observations, 1, 'partial cash applications count distinct invoice observations')
      assert.equal(result.customers[0]!.deteriorating, false, 'absent baseline history must not invent deterioration')
      const denied = await receivablesIntelligenceData(org.orgId, '2026-07-16', AS_OF, new Set())
      assert.equal(denied.summary.overdue, '0.0000'); assert.equal(denied.summary.recovered, '0.0000'); assert.equal(denied.summary.onTimeShare, null)
      assert.deepEqual(denied.customers, [])
      const before = await receivablesIntelligenceData(org.orgId, '2026-07-16', '2026-07-19', null)
      assert.equal(before.summary.overdue, '100.0001'); assert.equal(before.summary.recovered, '0.0000')
    })
  })
})

test('customer pagination and search preserve complete portfolio metrics and clamp stale pages', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withFixture(async (org, actor) => {
    await withBypassContext(async () => {
      for (let index = 1; index <= 26; index++) {
        const party = randomUUID()
        await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${party}, ${org.orgId}, 'customer', ${`Portfolio customer ${index}`}, true, '{}'::jsonb)`)
        await postReceivable(org, actor, { amount: '1.0001', due: '2026-07-01', party })
      }
    })
    await withOrgContext(org.orgId, async () => {
      const first = await receivablesIntelligenceData(org.orgId, '2026-07-01', AS_OF, null)
      assert.equal(first.customerTotal, 26); assert.equal(first.customers.length, 24)
      const second = await receivablesIntelligenceData(org.orgId, '2026-07-01', AS_OF, null, { customerPage: '10000' })
      assert.equal(second.customerPage, 2); assert.equal(second.customers.length, 2)
      assert.deepEqual(second.summary, first.summary)
      const found = await receivablesIntelligenceData(org.orgId, '2026-07-01', AS_OF, null, { customerQ: 'Portfolio customer 26' })
      assert.equal(found.customerTotal, 1); assert.equal(found.customers[0]?.name, 'Portfolio customer 26')
      const selectedItems = await openItems(org.orgId, 'ar', AS_OF, undefined, found.customers[0]!.id!)
      assert.equal(selectedItems.length, 1, 'customer drawers must fetch only the selected customer’s open items')
      assert.equal(selectedItems[0]?.partyId, found.customers[0]?.id)
      assert.deepEqual(found.summary, first.summary, 'customer search must not silently narrow portfolio headline metrics')
    })
  })
})
