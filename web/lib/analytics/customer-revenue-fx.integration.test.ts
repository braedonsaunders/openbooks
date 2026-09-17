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
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const { customerData } = await import('./customer-data')

async function invoice(orgId: string, actor: string, subsidiaryId: string, partyId: string, revenue: string, currency: string, fxRate: string, date: string) {
  const id = randomUUID()
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
     currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, 'customer_invoice', 'draft', ${id}, ${subsidiaryId},
      ${partyId}, ${date}, ${currency}, ${fxRate}, ${revenue}, 0, ${revenue}, ${actor})`)
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${orgId}, ${id}, 1, (select id from accounts where org_id = ${orgId} and type = 'income' limit 1), 1, ${revenue}, ${revenue}, 0, ${revenue})`)
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
  const control = (await db.execute<{ ar: string; ap: string; bank: string }>(sql`
    select (select id from accounts where org_id = ${orgId} and type = 'asset_receivable' limit 1) as ar,
           (select id from accounts where org_id = ${orgId} and type = 'liability_payable' limit 1) as ap,
           (select id from accounts where org_id = ${orgId} and type = 'asset_bank' limit 1) as bank`)).rows[0]!
  await postDocument(id, { control: { ar: control.ar, ap: control.ap, bank: control.bank } })
  return id
}

/**
 * Customer-intelligence revenue must be stated in the org's functional
 * currency like every other money figure on the dashboard: a 100 EUR invoice
 * at 1.2 is 120 CAD of revenue, not 100. Summing raw document totals mixes
 * transaction currencies (vendor-performance already reads functional ledger
 * amounts, so the two dashboards disagree with each other too).
 */
test('customer revenue translates foreign-currency invoices at document FX', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Customer Controller', 'admin'))
    const euroCustomer = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${euroCustomer}, ${scratch.orgId}, 'customer', 'Euro Customer', true, '{}'::jsonb)`)
      await invoice(scratch.orgId, actor, scratch.subsidiaryId, scratch.customerId, '100', 'CAD', '1', scratch.date)
      await invoice(scratch.orgId, actor, scratch.subsidiaryId, euroCustomer, '100', 'EUR', '1.2', scratch.date)
    })
    const data = await withOrgContext(scratch.orgId, () => customerData({ from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, scratch.orgId, null))
    const byName = new Map(data.rows.map((r) => [r.name, r]))
    assert.equal(byName.get('Acme Customer')?.revenue, 100)
    assert.equal(byName.get('Euro Customer')?.revenue, 120)
    assert.equal(data.kpis.totalRevenue, 220)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
