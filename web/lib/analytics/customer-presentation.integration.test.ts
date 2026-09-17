import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/clock.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const { customerData } = await import('./customer-data')

async function invoice(orgId: string, actor: string, subsidiaryId: string, partyId: string, revenue: string, currency: string, fxRate: string, date: string, accounts: { ar: string; ap: string; bank: string; revenue: string }) {
  const id = randomUUID()
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
     currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, 'customer_invoice', 'draft', ${id}, ${subsidiaryId},
      ${partyId}, ${date}, ${currency}, ${fxRate}, ${revenue}, 0, ${revenue}, ${actor})`)
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${orgId}, ${id}, 1, ${accounts.revenue}, 1, ${revenue}, ${revenue}, 0, ${revenue})`)
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
  await postDocument(id, { control: { ar: accounts.ar, ap: accounts.ap, bank: accounts.bank } })
  return id
}

/**
 * Customer-intelligence revenue is stated in the org's presentation
 * currency: a USD 200 invoice in a USD subsidiary is 270 CAD of revenue —
 * the document rate only reaches the posting subsidiary's functional, so
 * the dashboard needs the second leg, functional→presentation, on revenue,
 * prior revenue, growth months, cohorts, and credit friction alike.
 */
test('customer intelligence translates every revenue functional to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Customer Controller', 'admin'))
    const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }
    await withBypass(async () => {
      const usSub = randomUUID()
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${usSub}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2),('EUR','Euro',2) on conflict (code) do nothing`)
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${scratch.orgId},'EUR','CAD','2026-07-14','spot',1.5,'manual'),
               (${scratch.orgId},'USD','CAD','2026-07-14','spot',1.35,'manual'),
               (${scratch.orgId},'USD','CAD','2025-07-14','spot',1.3,'manual')`)
      const calRow = await db.execute(sql`select fiscal_calendar_id from accounting_periods where id = ${scratch.periodId}`)
      const calRow0 = calRow.rows[0]
      if (!calRow0) throw new Error('scratch period has no fiscal calendar')
      const cal = String(calRow0.fiscal_calendar_id)
      const priorPeriod = randomUUID()
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${priorPeriod}, ${scratch.orgId}, 2025, 7, '2025-07', '2025-07-01', '2025-07-31', false, ${cal})`)
      const euroCustomer = randomUUID()
      const usCustomer = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${euroCustomer}, ${scratch.orgId}, 'customer', 'Euro Customer', true, '{}'::jsonb)`)
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${usCustomer}, ${scratch.orgId}, 'customer', 'US Customer', ${usSub}, true, '{}'::jsonb)`)
      const accts = { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank, revenue: scratch.accounts.revenue }
      await invoice(scratch.orgId, actor, scratch.subsidiaryId, scratch.customerId, '100', 'CAD', '1', scratch.date, accts)
      await invoice(scratch.orgId, actor, scratch.subsidiaryId, euroCustomer, '100', 'EUR', '1.5', scratch.date, accts)
      await invoice(scratch.orgId, actor, usSub, usCustomer, '200', 'USD', '1', scratch.date, accts)
      await invoice(scratch.orgId, actor, usSub, usCustomer, '100', 'USD', '1', '2025-07-15', accts)
    })
    await pinClock('2026-07-15', async () => {
      const data = await withOrgContext(scratch.orgId, () => customerData(P, scratch.orgId, null))
      const byName = new Map(data.rows.map((r) => [r.name, r]))
      assert.equal(byName.get('US Customer')?.revenue, 270)
      assert.equal(byName.get('US Customer')?.priorRevenue, 130)
      assert.equal(data.kpis.totalRevenue, 520)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

/**
 * A document rate that never terminates (USD→CAD 1.3333333333) must round
 * its functional first leg to ledger precision — never throw a precision
 * error out of the dashboard.
 */
test('customer revenue rounds a non-terminating document rate instead of throwing', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Customer Controller', 'admin'))
    await withBypass(async () => {
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${scratch.orgId},'USD','CAD',${scratch.date}::date,'spot',1.3333333333,'manual')`)
      const accts = { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank, revenue: scratch.accounts.revenue }
      await invoice(scratch.orgId, actor, scratch.subsidiaryId, scratch.customerId, '100', 'USD', '1.3333333333', scratch.date, accts)
    })
    await pinClock('2026-07-15', async () => {
      const data = await withOrgContext(scratch.orgId, () => customerData({ from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, scratch.orgId, null))
      const byName = new Map(data.rows.map((r) => [r.name, r]))
      assert.equal(byName.get('Acme Customer')?.revenue, 133.3333)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('customer intelligence fails closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Customer Controller', 'admin'))
    await withBypass(async () => {
      const usSub = randomUUID()
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${usSub}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
      const usCustomer = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${usCustomer}, ${scratch.orgId}, 'customer', 'US Customer', ${usSub}, true, '{}'::jsonb)`)
      const accts = { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank, revenue: scratch.accounts.revenue }
      await invoice(scratch.orgId, actor, usSub, usCustomer, '200', 'USD', '1', scratch.date, accts)
    })
    await pinClock('2026-07-15', async () => {
      await assert.rejects(
        withOrgContext(scratch.orgId, () => customerData({ from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, scratch.orgId, null)),
        /no spot rate for USD/,
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
