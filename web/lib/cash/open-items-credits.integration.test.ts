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
const { openItems } = await import('./open-items')

async function postBill(
  scratch: { orgId: string; subsidiaryId: string; vendorId: string; customerId: string; accounts: { cogs: string; revenue: string; ar: string; ap: string; bank: string }; date: string },
  actor: string,
  kind: 'vendor_bill' | 'vendor_credit' | 'customer_invoice' | 'customer_credit',
  total: number,
) {
  const id = randomUUID()
  const party = kind.startsWith('vendor_') ? scratch.vendorId : scratch.customerId
  const lineAccount = kind.startsWith('vendor_') ? scratch.accounts.cogs : scratch.accounts.revenue
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
     currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${scratch.orgId}, ${kind}, 'draft', ${id}, ${scratch.subsidiaryId},
      ${party}, ${scratch.date}, 'CAD', '1', ${total}, 0, ${total}, ${actor})`)
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${scratch.orgId}, ${id}, 1, ${lineAccount}, 1, ${total}, ${total}, 0, ${total})`)
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
  await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
}

/**
 * An unapplied vendor credit is a negative payable: the cash forecast must
 * net it against the party's bills (the aging report already does), not
 * pretend the gross bills are all still due.
 */
test('open items net unapplied vendor credits against AP bills', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Credit Controller', 'admin'))
    await withBypass(async () => {
      await postBill(scratch, actor, 'vendor_bill', 1000)
      await postBill(scratch, actor, 'vendor_credit', 300)
    })
    // The reader resolves the org's base currency through RLS like production's
    // request scope, so read under the org context (bare reads see no org row
    // and fail closed with 'has no base currency').
    const items = await withOrgContext(scratch.orgId, () => openItems(scratch.orgId, 'ap', '2026-07-31'))
    assert.equal(items.length, 2)
    const net = items.reduce((sum, item) => sum + Number(item.remaining), 0)
    assert.equal(net.toFixed(4), '700.0000')
    const credit = items.find((item) => item.docKind === 'vendor_credit')
    assert.equal(credit?.remaining, '-300.0000')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('open items net unapplied customer credits against AR invoices', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Credit Controller', 'admin'))
    await withBypass(async () => {
      await postBill(scratch, actor, 'customer_invoice', 500)
      await postBill(scratch, actor, 'customer_credit', 200)
    })
    const items = await withOrgContext(scratch.orgId, () => openItems(scratch.orgId, 'ar', '2026-07-31'))
    assert.equal(items.length, 2)
    const net = items.reduce((sum, item) => sum + Number(item.remaining), 0)
    assert.equal(net.toFixed(4), '300.0000')
    const credit = items.find((item) => item.docKind === 'customer_credit')
    assert.equal(credit?.remaining, '-200.0000')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
