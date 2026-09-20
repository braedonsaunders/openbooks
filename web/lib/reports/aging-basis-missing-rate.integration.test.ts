import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { agingByParty, agingDetail, AgingRatesUnavailableError } = await import('./aging')

/**
 * A document currency with no as-of spot must fail the TRANSACTION basis
 * closed (with the exact uncovered pair) and must never block the BASE basis,
 * which converts nothing through it. This is the guard behind the reporting
 * contract: the default numbers stay available while the opt-in basis refuses
 * to guess a rate.
 */
test('transaction basis fails closed on uncovered spots; base basis never needs them', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Aging Controller', 'admin'))
    const id = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'GBP', '1.7', 50, 0, 50, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, 50, 50, 0, 50)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
      await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
    })
    await withOrgContext(scratch.orgId, async () => {
      // No GBP spot exists: the base report reads the stored base regardless.
      const base = await agingByParty('ar', scratch.date, undefined, scratch.orgId)
      assert.equal(base.totals.total, '85.0000')
      const baseDetail = await agingDetail('ar', scratch.date, undefined, scratch.orgId)
      assert.equal(baseDetail.rows[0]?.docCurrency, 'GBP')
      assert.equal(baseDetail.rows[0]?.txnOpen, '50.0000')

      await assert.rejects(
        agingByParty('ar', scratch.date, undefined, scratch.orgId, { basis: 'transaction' }),
        (e: unknown) => {
          assert.ok(e instanceof AgingRatesUnavailableError)
          assert.deepEqual(e.missing, ['GBP'])
          assert.equal(e.reportingCurrency, 'CAD')
          return true
        },
      )
      await assert.rejects(
        agingDetail('ar', scratch.date, undefined, scratch.orgId, { basis: 'transaction' }),
        /no spot rate for GBP→CAD/,
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
