import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const { partnerStatement } = await import('./reports/registers')

/**
 * A party statement is addressed to ONE party: its opening and closing must
 * reflect that party's control-account balance even when the party has no
 * lines inside the window. A July invoice with no August activity still owes
 * 100 on an August statement — opening 100, no lines, closing 100 — never a
 * zero statement beside a 100 aging footer.
 */
test('partner statement keeps the balance for a party with no window activity', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Statement Controller', 'admin'))
    await withBypass(async () => {
      const id = randomUUID()
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
          ${scratch.customerId}, '2026-07-10', 'CAD', '1', 100, 0, 100, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, 100, 100, 0, 100)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
      await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
    })
    const st = await partnerStatement(scratch.customerId, scratch.orgId, {
      from: '2026-08-01', to: '2026-08-31', side: 'ar',
    })
    assert.equal(st.opening, '100.0000')
    assert.equal(st.closing, '100.0000')
    assert.deepEqual(st.lines, [])
    assert.equal(st.aging.total, '100.0000')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
