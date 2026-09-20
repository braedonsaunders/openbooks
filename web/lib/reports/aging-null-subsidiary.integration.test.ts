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
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { agingByParty } = await import('./aging')
const { partnerBalances } = await import('./statements')

/**
 * Root-owned documents (documents.subsidiary_id null MEANS the org's root
 * subsidiary — the posting kernel stamps their journal legs with the root
 * id) must read consistently: an unrestricted caller sees them whether or
 * not a subsidiary context resolved (single-entity orgs pass no predicate;
 * multi-entity consolidated views must not silently drop them), while a
 * restricted caller never does (fail closed). The line-based GL readers
 * include root-stamped legs under any entity-covering scope, so a
 * document reader that drops the null header breaks the tie-out.
 */
async function seedPostedInvoice(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  input: { number: string; subsidiaryId: string | null; total: string },
) {
  const documentId = randomUUID()
  const entryId = randomUUID()
  await db.execute(sql`
    insert into documents(
      id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
      posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance
    ) values (
      ${documentId}, ${org.orgId}, 'customer_invoice', ${input.number}, ${org.customerId},
      ${input.subsidiaryId}, ${org.date}, ${org.date}, 'CAD',
      '1', 'draft', ${input.total}, 0, ${input.total}, ${input.total}
    )
  `)
  // The posting kernel resolves a null header exactly once, stamping every
  // leg with the root subsidiary — emulate that stamping here.
  await db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, source_document_id, created_by, updated_by
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${input.number},
      ${org.date}, ${org.periodId}, 'draft', 'manual', ${documentId}, ${actorId}, ${actorId}
    )
  `)
  await db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
      is_open_item, amount, currency, txn_amount, fx_rate
    ) values
      (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId},
       ${org.customerId}, true, ${input.total}, 'CAD', ${input.total}, '1'),
      (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId},
       ${org.customerId}, false, ${`-${input.total}`}, 'CAD', ${`-${input.total}`}, '1')
  `)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
  await db.execute(sql`
    update documents
       set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
     where id = ${documentId} and org_id = ${org.orgId}
  `)
}

test('unrestricted consolidated aging includes root-owned null-subsidiary invoices', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'AR clerk', 'admin'))
  try {
    const branchId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'AR branch', 'CAD', 'CA')
      `)
      await seedPostedInvoice(scratch, actorId, { number: 'INV-BRANCH', subsidiaryId: branchId, total: '100' })
      await seedPostedInvoice(scratch, actorId, { number: 'INV-ROOT-NULL', subsidiaryId: null, total: '400' })
    })

    const asOf = scratch.date
    const root = scratch.subsidiaryId
    const all = [root, branchId]
    const sum = (rows: { balance: string }[]) => rows.reduce((n, r) => n + Number(r.balance), 0)

    const unscoped = await withBypass(() => agingByParty('ar', asOf, undefined, scratch.orgId))
    assert.equal(Number(unscoped.totals.total), 500, 'unscoped aging includes the root-owned invoice')

    const gl = await withBypass(() => partnerBalances('receivable', scratch.orgId, asOf, undefined, { subsidiaryIds: all }))
    assert.equal(sum(gl), 500, 'the line-based GL carries both invoices under an entity-covering scope')

    const consolidated = await withBypass(() =>
      agingByParty('ar', asOf, { subsidiaryIds: all, includeNullSubsidiary: true }, scratch.orgId),
    )
    assert.equal(
      Number(consolidated.totals.total),
      500,
      'an unrestricted consolidated view reads the root-owned invoice exactly like the GL does',
    )

    const restricted = await withBypass(() => agingByParty('ar', asOf, { subsidiaryIds: [branchId] }, scratch.orgId))
    assert.equal(Number(restricted.totals.total), 100, 'a restricted scope still fails closed on null headers')

    const empty = await withBypass(() =>
      agingByParty('ar', asOf, { subsidiaryIds: [], includeNullSubsidiary: true }, scratch.orgId),
    )
    assert.equal(Number(empty.totals.total), 0, 'an empty scope reads nothing even with the unrestricted limb')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
