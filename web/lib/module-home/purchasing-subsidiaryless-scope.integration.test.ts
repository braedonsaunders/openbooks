import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/clock.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { purchasingHome } = await import('./purchasing')

/**
 * Restricted cockpit scopes hide documents with no subsidiary — the
 * canonical document rule the lists enforce. A null-subsidiary bill must not
 * leak into a restricted caller's spend.
 */
async function seedPostedBill(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  input: { number: string; subsidiaryId: string | null; total: string },
) {
  const documentId = randomUUID()
  const entryId = randomUUID()
  await db.execute(sql`
    insert into documents(
      id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
      posting_date, currency, fx_rate, status, subtotal, tax_total, total
    ) values (
      ${documentId}, ${org.orgId}, 'vendor_bill', ${input.number}, ${org.vendorId},
      ${input.subsidiaryId}, '2026-07-14', '2026-07-14', 'CAD',
      '1', 'draft', ${input.total}, 0, ${input.total}
    )
  `)
  await db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, source_document_id
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${input.number},
      '2026-07-14', ${org.periodId}, 'draft', 'manual', ${documentId}
    )
  `)
  await db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
      is_open_item, amount, currency, txn_amount, fx_rate
    ) values
      (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId},
       ${org.vendorId}, true, ${`-${input.total}`}, 'CAD', ${`-${input.total}`}, '1'),
      (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
       ${org.vendorId}, false, ${input.total}, 'CAD', ${input.total}, '1')
  `)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
  await db.execute(sql`
    update documents
       set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
     where id = ${documentId} and org_id = ${org.orgId}
  `)
}

test('restricted spend excludes subsidiary-less bills', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Buyer', 'admin'))
    const branchId = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Spend branch', 'CAD', 'CA')
    `))
    await pinClock('2026-07-15', async () => {
      await withBypassContext(() => seedPostedBill(org, actorId, { number: 'BILL-BRANCH', subsidiaryId: branchId, total: '100' }))
      await withBypassContext(() => seedPostedBill(org, actorId, { number: 'BILL-NOSUB', subsidiaryId: null, total: '500' }))

      const home = await withOrgContext(org.orgId, () => purchasingHome(org.orgId, [branchId]))
      assert.equal(home.spend30d, 100, 'branch scope sees only the branch bill')
      const all = await withOrgContext(org.orgId, () => purchasingHome(org.orgId))
      assert.equal(all.spend30d, 600, 'unrestricted callers still see everything')
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
