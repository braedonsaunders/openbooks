import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { CustomerPulseSections } from './customer-pulse.ts'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/ledger/posting-document.ts')
const { loadCustomerPulse } = await import('./customer-pulse.ts')

const FULL: CustomerPulseSections = { ar: true, crm: true, projects: true }

/**
 * One explicit presentation currency — the org base — for the whole pulse.
 * A CAD org with mixed-currency orders labels CAD (never an invented USD),
 * translates every monetary input through the house FX path at a stated
 * rate date, and refuses by name when a rate is missing instead of mixing
 * currencies into the headroom.
 */
test('customer pulse presents in the org base and translates mixed currencies', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Pulse Currency', 'admin'))
    const invoiceId = randomUUID()
    const orderId = randomUUID()
    const statusId = randomUUID()
    const oppId = randomUUID()
    const bareParty = randomUUID()
    await withBypass(async () => {
      const orgRow = (await db.execute(
        sql`select base_currency from orgs where id = ${scratch.orgId}`,
      )).rows[0] as { base_currency: string } | undefined
      assert.equal(orgRow?.base_currency, 'CAD')
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, credit_limit, currency)
        values (${scratch.orgId}, ${scratch.customerId}, 10000, 'CAD')`)
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${scratch.orgId}, 'customer_invoice', 'draft', ${invoiceId}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 1000, 0, 1000, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${invoiceId}, 1, ${scratch.accounts.revenue}, 1, 1000, 1000, 0, 1000)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId}`)
      await postDocument(invoiceId, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      // USD order: 100 USD at 1.35 lands as 135 CAD, not 100 raw.
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${orderId}, ${scratch.orgId}, 'sales_order', 'approved', ${orderId}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'USD', '1.35', 100, 0, 100, ${actor})`)
      await db.execute(sql`
        insert into crm_opportunity_statuses (id, org_id, key, name, sequence, probability, is_closed, is_won, is_active)
        values (${statusId}, ${scratch.orgId}, 'negotiation', 'Negotiation', 10, 60, false, false, true)`)
      await db.execute(sql`
        insert into crm_opportunities (id, org_id, opportunity_number, title, party_id, status_id,
               forecast_category, probability, currency, projected_amount, weighted_amount,
               expected_close_date, is_active)
        values (${oppId}, ${scratch.orgId}, 'OPP-FX', 'Cross-border deal', ${scratch.customerId}, ${statusId},
               'most_likely', 60, 'USD', '1000', '600', ${scratch.date}, true)`)
      await db.execute(sql`
        insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, created_by)
        values (${scratch.orgId}, 'USD', 'CAD', ${scratch.date}, 'spot', '1.30', ${actor})`)
      // A customer with no role row at all: still the org base, never USD.
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${bareParty}, ${scratch.orgId}, 'customer', 'Bare Customer', true, '{}'::jsonb)`)
    })

    await withOrgContext(scratch.orgId, async () => {
      const pulse = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, FULL)
      assert.ok(pulse)
      assert.equal(pulse.party.currency, 'CAD')
      assert.equal(pulse.credit?.unbilledOrdersBalance, '135.0000')
      assert.equal(pulse.credit?.openArBalance, '1000.0000')
      assert.equal(pulse.credit?.remainingCredit, '8865.0000')
      assert.equal(pulse.pipeline?.projectedPipeline, '1300.0000')
      assert.equal(pulse.pipeline?.weightedPipeline, '780.0000')

      const bare = await loadCustomerPulse(bareParty, scratch.orgId, null, FULL)
      assert.ok(bare)
      assert.equal(bare.party.currency, 'CAD')
    })

    // Drop the rate: the pulse must refuse by name, not mix currencies.
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${scratch.orgId}`)
    })
    await withOrgContext(scratch.orgId, async () => {
      await assert.rejects(
        loadCustomerPulse(scratch.customerId, scratch.orgId, null, FULL),
        /no spot rate for USD→CAD/,
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
