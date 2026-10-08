import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { bankingHome, bankingReconCount } = await import('./banking.ts')

/**
 * An explicitly empty subsidiary scope is a caller whose role visibility
 * resolved to nothing (e.g. a restricted role with no visible entities).
 * The cockpit must read NO rows for them — never degrade to the whole
 * organization. Sibling readers (accounting, payroll, customers, cash)
 * fail closed on []; banking must match.
 */
test('banking cockpit denies every row to an empty subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Bank clerk', 'admin'))
  try {
    await withBypass(async () => {
      await db.execute(sql`
        update accounts set reconcilable = true, currency_restriction = 'CAD' where id = ${scratch.accounts.bank} and org_id = ${scratch.orgId}
      `)
      const statementId = randomUUID()
      await db.execute(sql`insert into bank_statements(id,org_id,account_id,source,statement_date,raw_file_ref)
        values(${statementId},${scratch.orgId},${scratch.accounts.bank},'manual',${scratch.date}::date,'audit-log:test#evidence=legacy-source-unavailable')`)
      await db.execute(sql`insert into bank_statement_lines(id,org_id,statement_id,account_id,line_number,posted_on,amount,currency)
        values(${randomUUID()},${scratch.orgId},${statementId},${scratch.accounts.bank},1,${scratch.date}::date,'250.0000','CAD')`)
      const entryId = randomUUID()
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
        values
          (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
           'BANK-EMPTY-SCOPE', ${scratch.date}, ${scratch.periodId},
           'Bank empty scope', 'draft', 'manual', ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
        values
          (${randomUUID()}, ${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId},
           '250.0000', 'CAD', '250.0000', 1, 'Bank empty scope'),
          (${randomUUID()}, ${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.adjustment}, ${scratch.subsidiaryId},
           '-250.0000', 'CAD', '-250.0000', 1, 'Bank empty scope')
      `)
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
         where id = ${entryId} and org_id = ${scratch.orgId}
      `)
    })

    const denied = await withBypass(() => bankingHome(scratch.orgId, []))
    assert.equal(denied.accounts.length, 0, 'empty scope exposes no shared-account roster metadata')
    assert.equal(denied.unmatchedLines, 0, 'empty scope exposes no statement workflow counts')
    assert.equal(denied.badges.statements, 0)
    assert.equal(denied.badges.lastImportedAt, null)
    assert.equal(await withBypass(() => bankingReconCount(scratch.orgId, [])), 0)
    assert.equal(denied.totalCash, '0.0000', 'empty scope reads no cash')
    assert.ok(
      denied.accounts.every((a) => a.balance === '0.0000'),
      'empty scope carries no bank balance on any roster row',
    )
    assert.ok(
      denied.trend.every((w) => w.balance === '0.0000'),
      'empty scope trend stays at zero',
    )
    assert.equal(denied.netFlow7d, '0', 'empty scope reads no flow')

    const all = await withBypass(() => bankingHome(scratch.orgId))
    assert.equal(all.totalCash, '250.0000', 'unrestricted callers still see the balance')
    assert.equal(all.accounts.length, 1)
    assert.equal(all.unmatchedLines, 1)
    assert.equal(await withBypass(() => bankingReconCount(scratch.orgId)), 1)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
