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
import { withAnalyticsRead } from './read-context'

const AS_OF = '2026-07-31'
type Org = Awaited<ReturnType<typeof createScratchOrg>>

async function postReceivable(org: Org, actor: string, input: {
  amount: string; due: string | null; party?: string; subsidiary?: string; currency?: string; credit?: boolean
}) {
  const id = randomUUID()
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, ${input.credit ? 'customer_credit' : 'customer_invoice'}, 'draft', ${id},
      ${input.subsidiary ?? org.subsidiaryId}, ${input.party ?? org.customerId}, ${org.date}, ${input.due},
      ${input.currency ?? 'CAD'}, 1, ${input.amount}, 0, ${input.amount}, ${actor})`)
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, ${input.amount}, ${input.amount}, 0, ${input.amount})`)
  const approved = await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${id} returning id`)
  assert.equal(approved.rows.length, 1, 'the fixture document must reach its approved state before posting')
  await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })
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
    })
    const authz = { user: { orgId: org.orgId, id: actor }, permissions: new Set(['reports.read', 'ar.read']), allowedSubsidiaryIds: null } as Authz
    const context = { authz, slug: 'receivables-intelligence', locale: 'en', revision: randomUUID(), observedAt: Date.now() }
    await withOrgContext(org.orgId, async () => {
      const summary = await withAnalyticsRead({ ...context, projection: 'summary', tab: '' }, () => receivablesData(org.orgId, AS_OF, null))
      assert.deepEqual(summary.customers, [])
      const customers = await withAnalyticsRead({ ...context, projection: 'tab', tab: 'customers' }, () => receivablesData(org.orgId, AS_OF, null))
      assert.deepEqual(customers.summary, summary.summary, 'the card and selected tab must reuse the complete authoritative metric projection')
      assert.equal(customers.summary.customers, 15)
      assert.equal(customers.summary.documents, 15)
      assert.equal(customers.summary.outstanding, '1500.0000')
      assert.equal(customers.customers.length, 12, 'only the ranked customer evidence is bounded')
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
