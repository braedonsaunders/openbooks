import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { accountRegister } = await import('./reports/registers.ts')

// The register's lines and its independent totals read the same posted
// set: a draft entry visible in the same account must move neither.
test('the account register shows only posted ledger entries in lines and totals', async () => {
  await withBypassContext(async () => {
    const scratch = await createScratchOrg()
    try {
      const accountId = randomUUID()
      const offsetAccountId = randomUUID()
      const postedEntryId = randomUUID()
      const draftEntryId = randomUUID()
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active)
          values
            (${accountId}, ${scratch.orgId}, 'RGO-1', 'Posted-only register', 'asset_bank', false, true),
            (${offsetAccountId}, ${scratch.orgId}, 'RGO-2', 'Posted-only offset', 'income', false, true)
        `)
        for (const [entryId, status, amount] of [
          [postedEntryId, 'posted', '100.0000'],
          [draftEntryId, 'draft', '40.0000'],
        ] as const) {
          await db.execute(sql`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
            values
              (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, ${`RGO-${status}`},
               ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')
          `)
          await db.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
            values
              (${scratch.orgId}, ${entryId}, 1, ${accountId}, ${scratch.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
              (${scratch.orgId}, ${entryId}, 2, ${offsetAccountId}, ${scratch.subsidiaryId}, ${`-${amount}`} , 'CAD', ${`-${amount}`}, '1')
          `)
          if (status === 'posted') {
            await db.execute(sql`
              update journal_entries set status = 'posted', posted_at = now()
               where id = ${entryId} and org_id = ${scratch.orgId}
            `)
          }
        }
      })

      const register = await accountRegister(scratch.orgId, accountId, 100, 0, undefined, null, scratch.bookId)
      assert.equal(register.total, 1, 'only the posted line counts toward the total')
      assert.equal(register.lines.length, 1, 'only the posted line is listed')
      assert.equal(register.lines[0]?.amount, '100.0000')
      assert.equal(register.balance, '100.0000', 'the draft 40.0000 moves neither lines nor balance')
    } finally { await dropScratchOrg(scratch.orgId) }
  })
})
