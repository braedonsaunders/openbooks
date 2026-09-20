import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { businessToday } = await import('@openbooks/engine/src/platform/business-date.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { bankingHome } = await import('./banking.ts')

/**
 * Banking cockpit book scope: secondary-book postings are real posted
 * journal entries, but the cockpit (like bank reconciliation itself) reads
 * the primary posting book. A tax-book adjustment must not inflate roster
 * balances, the cash total, the trend, or net flow.
 */
test('banking cockpit reads the primary book only', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Bank clerk', 'admin'))
  try {
    const secondary = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        update accounts set reconcilable = true, currency_restriction = 'CAD' where id = ${scratch.accounts.bank} and org_id = ${scratch.orgId}
      `)
      await db.execute(sql`
        insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${secondary}, ${scratch.orgId}, 'TAX', 'Tax', false, true, true)
      `)
      for (const [bookId, amount, label] of [
        [scratch.bookId, '100.0000', 'primary'],
        [secondary, '60.0000', 'secondary'],
      ] as const) {
        const entryId = randomUUID()
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values
            (${entryId}, ${scratch.orgId}, ${bookId}, ${scratch.subsidiaryId},
             ${`BANK-BOOK-${label}`}, ${scratch.date}, ${scratch.periodId},
             ${`Bank book scope ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
        `)
        await db.execute(sql`
          insert into journal_lines
            (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
          values
            (${randomUUID()}, ${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId},
             ${amount}, 'CAD', ${amount}, 1, ${`Bank book scope ${label}`}),
            (${randomUUID()}, ${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.adjustment}, ${scratch.subsidiaryId},
             ${'-' + amount}, 'CAD', ${'-' + amount}, 1, ${`Bank book scope ${label}`})
        `)
        await db.execute(sql`
          update journal_entries
             set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
           where id = ${entryId} and org_id = ${scratch.orgId}
        `)
      }
    })

    const home = await withBypass(() => bankingHome(scratch.orgId))
    const bank = home.accounts.find((a) => a.id === scratch.accounts.bank)
    assert.ok(bank, 'roster carries the bank account')
    assert.equal(bank.balance, 100, 'roster balance excludes the secondary-book posting')
    assert.equal(home.totalCash, 100, 'cash total excludes the secondary-book posting')
    // netFlow7d rides the same book-scoped flows query as the trend (the
    // fixture period predates the trailing-7-day window, so it is covered
    // through the trend assertion below).
    assert.ok(home.trend.length > 0)
    assert.equal(
      home.trend[home.trend.length - 1]!.balance,
      100,
      'trend excludes the secondary-book posting',
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('restricted transaction badge excludes subsidiary-less documents', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const today = await withBypass(() => businessToday(scratch.orgId))
    const branchId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Txn branch', 'CAD', 'CA')
      `)
      for (const [subsidiary, number] of [[branchId, 'TXN-BRANCH'], [null, 'TXN-NOSUB']] as const) {
        // The 7-day badge counts posted documents only (F-t05-009), so the
        // scope fixture posts each document through a balanced entry.
        const docId = randomUUID()
        const entryId = randomUUID()
        const entrySub = subsidiary ?? scratch.subsidiaryId
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, subsidiary_id, document_date, currency, status)
          values
            (${docId}, ${scratch.orgId}, 'deposit', ${number}, ${subsidiary}, ${today}, 'CAD', 'draft')
        `)
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
          values
            (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${entrySub}, ${number}, ${today}, ${scratch.periodId}, 'draft', 'manual', ${docId})
        `)
        await db.execute(sql`
          insert into journal_lines
            (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values
            (${randomUUID()}, ${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank}, ${entrySub}, '10.0000', 'CAD', '10.0000', 1),
            (${randomUUID()}, ${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.adjustment}, ${entrySub}, '-10.0000', 'CAD', '-10.0000', 1)
        `)
        await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
        await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${scratch.periodId} where id=${docId}`)
      }
    })

    const restricted = await withBypass(() => bankingHome(scratch.orgId, [branchId]))
    assert.equal(restricted.badges.txns7d, 1, 'branch scope sees only the branch document')
    const all = await withBypass(() => bankingHome(scratch.orgId))
    assert.equal(all.badges.txns7d, 2, 'unrestricted callers still see everything')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
