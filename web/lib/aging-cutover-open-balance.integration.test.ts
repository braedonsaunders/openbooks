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
const { agingByParty, agingDetail } = await import('./reports/aging')

/**
 * The AR/AP aging rebuilds opens from posted open-item journal lines — it
 * never reads the documents.open_balance cache. That is safe for imported
 * cutover AR/AP only because a cache-only posted document cannot exist: the
 * schema requires every posted document to carry a posted entry
 * (documents_posted_period_required), and open_balance itself is derived
 * from that entry's lines (NULL without them), never imported as a bare
 * value. The first test pins the constraint; the second proves the shape an
 * importer actually produces — a kernel-posted invoice — is aged by both
 * readers.
 */
test('a posted invoice without a posted entry is rejected, so the aging join cannot miss it', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Cutover Controller', 'admin'))
    const id = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 500, 0, 500, ${actor})`)
      // A draft without an entry is fine …
      const draft = (await db.execute<{ status: string }>(sql`select status from documents where id = ${id}`)).rows[0]!
      assert.equal(draft.status, 'draft')
      // … but flipping it to posted with no posted entry — the phantom an
      // importer would have to create to escape the aging — is rejected.
      await assert.rejects(
        db.execute(sql`update documents set status = 'posted' where id = ${id}`),
        (error: unknown) => {
          const cause = (error as { cause?: { code?: string; constraint?: string } }).cause
          assert.equal(cause?.code, '23514')
          assert.equal(cause?.constraint, 'documents_posted_period_required')
          return true
        },
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('a kernel-posted cutover-shape invoice is aged from its posted lines', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Cutover Controller', 'admin'))
    await withBypass(async () => {
      const id = randomUUID()
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 500, 0, 500, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, 500, 500, 0, 500)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
      await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
    })
    // Reads run in the scratch org's scope: importing the aging reader pulls
    // in the web request-org resolver, which denies every query outside an
    // explicit scope (pooled RLS), so a bare read sees zero rows.
    await withOrgContext(scratch.orgId, async () => {
      const aging = await agingByParty('ar', '2026-12-31', undefined, scratch.orgId)
      assert.equal(aging.rows.length, 1)
      assert.equal(aging.totals.total, '500.0000')
      const detail = await agingDetail('ar', '2026-12-31', undefined, scratch.orgId)
      assert.equal(detail.rows.length, 1)
      assert.equal(detail.totals.total, '500.0000')
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
