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
 * The pulse is a combined payload: each section needs its own read. A
 * CRM-only caller gets pipeline/activity but no AR figures (balances,
 * credit controls, payment history); an AR-only caller gets receivables
 * but no pipeline/activity; omitted sections are absent — never zeroed.
 */
test('customer pulse gates each section by its own permission', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Pulse Controller', 'admin'))
    const invoiceId = randomUUID()
    const statusId = randomUUID()
    const oppId = randomUUID()
    const activityId = randomUUID()
    const projectId = randomUUID()
    await withBypass(async () => {
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
      // Hold AFTER posting: the kernel refuses new postings to held
      // customers, and the pulse must still surface the hold itself.
      await db.execute(sql`
        update customer_roles set is_on_hold = true, hold_reason = 'limit review hold',
               held_at = now(), held_by = ${actor}
         where org_id = ${scratch.orgId} and party_id = ${scratch.customerId}`)
      await db.execute(sql`
        insert into crm_opportunity_statuses (id, org_id, key, name, sequence, probability, is_closed, is_won, is_active)
        values (${statusId}, ${scratch.orgId}, 'negotiation', 'Negotiation', 10, 60, false, false, true)`)
      await db.execute(sql`
        insert into crm_opportunities (id, org_id, opportunity_number, title, party_id, status_id,
               forecast_category, probability, currency, projected_amount, weighted_amount, is_active)
        values (${oppId}, ${scratch.orgId}, 'OPP-1', 'Tower Fit-Out', ${scratch.customerId}, ${statusId},
               'most_likely', 60, 'CAD', '5000', '3000', true)`)
      await db.execute(sql`
        insert into crm_activities (id, org_id, kind, status, subject, priority)
        values (${activityId}, ${scratch.orgId}, 'call', 'completed', 'discovery call', 'high')`)
      await db.execute(sql`
        insert into crm_activity_links (org_id, activity_id, subject_kind, subject_id, created_by, updated_by)
        values (${scratch.orgId}, ${activityId}, 'account', ${scratch.customerId}, ${actor}, ${actor})`)
      await db.execute(sql`
        insert into projects (id, org_id, name, customer_id, subsidiary_id, status, contract_value, is_active)
        values (${projectId}, ${scratch.orgId}, 'Tower', ${scratch.customerId}, ${scratch.subsidiaryId}, 'active', 20000, true)`)
    })

    await withOrgContext(scratch.orgId, async () => {
      const full = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, FULL)
      assert.ok(full)
      assert.equal(full.aging?.totalOpen, 1000)
      assert.equal(full.credit?.creditLimit, 10000)
      assert.equal(full.pipeline?.projectedPipeline, 5000)
      assert.equal(full.projects?.totalCount, 1)
      assert.equal(full.party.creditLimit, 10000)
      assert.equal(full.party.isOnHold, true)
      assert.ok(full.timeline.some((t) => t.type === 'activity'))
      assert.ok(full.timeline.some((t) => t.type === 'invoice'))

      // CRM-only: pipeline/activity, no AR figures anywhere.
      const crm = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, { ar: false, crm: true, projects: false })
      assert.ok(crm)
      assert.equal(crm.pipeline?.projectedPipeline, 5000)
      assert.equal(crm.aging, undefined)
      assert.equal(crm.credit, undefined)
      assert.equal(crm.paymentMetrics, undefined)
      assert.equal(crm.projects, undefined)
      assert.ok(!('creditLimit' in crm.party))
      assert.ok(!('isOnHold' in crm.party))
      assert.ok(!('holdReason' in crm.party))
      assert.ok(!('paymentTermsName' in crm.party))
      assert.ok(crm.timeline.length > 0)
      assert.ok(crm.timeline.every((t) => t.type === 'activity'))

      // AR-only: receivables, no pipeline/activity.
      const ar = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, { ar: true, crm: false, projects: false })
      assert.ok(ar)
      assert.equal(ar.aging?.totalOpen, 1000)
      assert.equal(ar.credit?.creditLimit, 10000)
      assert.equal(ar.pipeline, undefined)
      assert.equal(ar.projects, undefined)
      assert.ok(ar.timeline.length > 0)
      assert.ok(ar.timeline.every((t) => t.type !== 'activity'))

      // Projects-only: rollup and identity, nothing else.
      const prj = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, { ar: false, crm: false, projects: true })
      assert.ok(prj)
      assert.equal(prj.projects?.totalCount, 1)
      assert.equal(prj.aging, undefined)
      assert.equal(prj.pipeline, undefined)
      assert.deepEqual(prj.timeline, [])

      // No sections: no access, no payload.
      assert.equal(await loadCustomerPulse(scratch.customerId, scratch.orgId, null, { ar: false, crm: false, projects: false }), null)
      assert.equal(await loadCustomerPulse(scratch.customerId, scratch.orgId, null, undefined), null)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
