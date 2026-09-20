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
 * Foreign-currency aging must survive an FX translation that carries material
 * digits past 4dp: 100.0000 EUR x 1.2345678901 = 123.45678901 functional.
 * The poster stores the base open rounded to ledger scale (123.4568) and the
 * aging reads that stored base, so the exact-decimal JS rollup never throws
 * and buckets always tie to the total.
 */
test('foreign-currency aging rounds translated opens to 4dp and ties out', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Aging Controller', 'admin'))
    const id = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'EUR', '1.2345678901', 100, 0, 100, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, 100, 100, 0, 100)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
      await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
    })
    // Reads run in the scratch org's scope: importing the aging reader pulls
    // in the web request-org resolver, which denies every query outside an
    // explicit scope (pooled RLS), so a bare read sees zero rows.
    await withOrgContext(scratch.orgId, async () => {
      const doc = (await db.execute<{ open_balance: string; fx_rate: string }>(sql`
        select open_balance::text, fx_rate::text from documents where id = ${id}`)).rows[0]!
      assert.equal(doc.open_balance, '100.0000')
      assert.equal(doc.fx_rate, '1.2345678901')

      const aging = await agingByParty('ar', scratch.date, undefined, scratch.orgId)
      assert.equal(aging.rows.length, 1)
      // The poster stores round(100 x 1.2345678901, 4) = 123.4568 as the
      // base open, and the aging reads that stored base — the tie-out holds.
      assert.equal(aging.totals.total, '123.4568')
      assert.equal(aging.rows[0]?.current, '123.4568')
      assert.equal(aging.totals.current, '123.4568')

      const detail = await agingDetail('ar', scratch.date, undefined, scratch.orgId)
      assert.equal(detail.rows.length, 1)
      assert.equal(detail.rows[0]?.open, '123.4568')
      assert.equal(detail.totals.total, '123.4568')
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
