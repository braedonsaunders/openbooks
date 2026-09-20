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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { accountBaseJoins } = await import('./customization/entity-list-query/accounts.ts')

test('account list balances exclude journal lines outside the caller subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const hiddenSubsidiary = randomUUID()
    const accountId = randomUUID()
    const offsetAccountId = randomUUID()
    const visibleEntry = randomUUID()
    const hiddenEntry = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden list entity', 'CAD', 'CA')
      `)
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active)
        values
          (${accountId}, ${scratch.orgId}, '1098', 'Scoped list account', 'asset_bank', false, true),
          (${offsetAccountId}, ${scratch.orgId}, '4098', 'Scoped list offset', 'income', false, true)
      `)
      for (const [entryId, number, subsidiaryId, amount, offset] of [
        [visibleEntry, 'ACCOUNT-LIST-VISIBLE', scratch.subsidiaryId, '100.0000', '-100.0000'],
        [hiddenEntry, 'ACCOUNT-LIST-HIDDEN', hiddenSubsidiary, '40.0000', '-40.0000'],
      ] as const) {
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
          values
            (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${subsidiaryId}, ${number}, ${scratch.date},
             ${scratch.periodId}, 'draft', 'manual')
        `)
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values
            (${scratch.orgId}, ${entryId}, 1, ${accountId}, ${subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
            (${scratch.orgId}, ${entryId}, 2, ${offsetAccountId}, ${subsidiaryId}, ${offset}, 'CAD', ${offset}, '1')
        `)
        await db.execute(sql`
          update journal_entries set status = 'posted', posted_at = now()
           where id = ${entryId} and org_id = ${scratch.orgId}
        `)
      }
    })

    const scopedJoin = (accountBaseJoins as unknown as (
      today: string,
      allowedSubsidiaryIds?: ReadonlySet<string> | null,
    ) => ReturnType<typeof accountBaseJoins>)(scratch.date, new Set([scratch.subsidiaryId]))
    const scoped = await withBypass(() => db.execute<{ balance: string }>(sql`
      select account_balance.amount::text as balance
        from accounts a
        ${scopedJoin}
       where a.org_id = ${scratch.orgId} and a.id = ${accountId}
    `))
    assert.equal(scoped.rows[0]?.balance, '100.0000')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
