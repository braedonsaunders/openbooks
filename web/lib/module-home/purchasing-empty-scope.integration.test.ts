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
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { purchasingHome } = await import('./purchasing')

/**
 * An explicitly empty subsidiary scope is a caller whose role visibility
 * resolved to nothing (e.g. a restricted role with no visible entities).
 * The cockpit must read NO rows for them — never degrade to the whole
 * organization. Sibling readers (accounting, payroll, customers, cash,
 * banking) fail closed on []; purchasing must match.
 */
test('purchasing cockpit denies every row to an empty subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Buyer', 'admin'))
  try {
    await pinClock('2026-07-15', async () => {
      await withBypass(async () => {
        const documentId = randomUUID()
        const entryId = randomUUID()
        await db.execute(sql`
          insert into documents(
            id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
            posting_date, currency, fx_rate, status, subtotal, tax_total, total
          ) values (
            ${documentId}, ${scratch.orgId}, 'vendor_bill', 'BILL-EMPTY-SCOPE', ${scratch.vendorId},
            ${scratch.subsidiaryId}, '2026-07-14', '2026-07-14', 'CAD',
            '1', 'draft', '100', 0, '100'
          )
        `)
        await db.execute(sql`
          insert into journal_entries(
            id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
            status, origin, source_document_id, created_by, updated_by
          ) values (
            ${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'BILL-EMPTY-SCOPE',
            '2026-07-14', ${scratch.periodId}, 'draft', 'manual', ${documentId}, ${actorId}, ${actorId}
          )
        `)
        await db.execute(sql`
          insert into journal_lines(
            id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
            is_open_item, amount, currency, txn_amount, fx_rate
          ) values
            (${randomUUID()}, ${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.ap}, ${scratch.subsidiaryId},
             ${scratch.vendorId}, true, '-100', 'CAD', '-100', '1'),
            (${randomUUID()}, ${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.cogs}, ${scratch.subsidiaryId},
             ${scratch.vendorId}, false, '100', 'CAD', '100', '1')
        `)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
        await db.execute(sql`
          update documents
             set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${scratch.periodId}
           where id = ${documentId} and org_id = ${scratch.orgId}
        `)
      })

      const denied = await withBypass(() => purchasingHome(scratch.orgId, []))
      assert.equal(denied.spend30d, 0, 'empty scope reads no spend')
      assert.equal(denied.apOutstanding, 0, 'empty scope reads no payables')
      assert.deepEqual(denied.topExposure, [], 'empty scope exposes no vendor')
      assert.ok(
        denied.trend.every((w) => w.spend === 0),
        'empty scope trend stays at zero',
      )

      const all = await withBypass(() => purchasingHome(scratch.orgId))
      assert.equal(all.spend30d, 100, 'unrestricted callers still see the spend')
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
