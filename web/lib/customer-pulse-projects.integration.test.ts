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
 * Project cost must come from the governed project financial reader — the
 * same measures the project cockpit Financials tab renders — never an
 * invented zero with a fabricated 100% margin. A project billed 100 with
 * 80 of posted costs reports cost 80, profit 20, margin 20%.
 */
test('customer pulse project rollup reports true cost and margin', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Pulse Projects', 'admin'))
    const projectId = randomUUID()
    const billId = randomUUID()
    const invoiceId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into projects (id, org_id, name, customer_id, subsidiary_id, status, contract_value, is_active)
        values (${projectId}, ${scratch.orgId}, 'Tower', ${scratch.customerId}, ${scratch.subsidiaryId}, 'active', 1000, true)`)
      // Posted vendor cost tagged to the project.
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${billId}, ${scratch.orgId}, 'vendor_bill', 'draft', ${billId}, ${scratch.subsidiaryId},
          ${scratch.vendorId}, ${scratch.date}, 'CAD', '1', 80, 0, 80, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount, project_id)
        values (${scratch.orgId}, ${billId}, 1, ${scratch.accounts.cogs}, 1, 80, 80, 0, 80, ${projectId})`)
      await db.execute(sql`update documents set status = 'approved' where id = ${billId}`)
      await postDocument(billId, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      // Posted customer billing tagged to the project.
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${scratch.orgId}, 'customer_invoice', 'draft', ${invoiceId}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 100, 0, 100, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount, project_id)
        values (${scratch.orgId}, ${invoiceId}, 1, ${scratch.accounts.revenue}, 1, 100, 100, 0, 100, ${projectId})`)
      await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId}`)
      await postDocument(invoiceId, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
    })

    await withOrgContext(scratch.orgId, async () => {
      const pulse = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, FULL)
      assert.ok(pulse?.projects)
      assert.equal(pulse.projects.totalCount, 1)
      assert.equal(pulse.projects.totalContractValue, 1000)
      assert.equal(pulse.projects.totalBilled, 100)
      assert.equal(pulse.projects.totalCost, 80)
      assert.equal(pulse.projects.grossProfit, 20)
      assert.equal(pulse.projects.grossMarginPercent, 20)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
