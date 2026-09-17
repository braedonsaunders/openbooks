import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { accountRegister } = await import('./reports/registers')

test('account registers scope both lines and totals within a visible intercompany header', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const child = randomUUID(), entry = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${child}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Other entity', 'CAD', 'CA')`)
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
          'REGISTER-SCOPE', ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${scratch.orgId}, ${entry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, '100', 'CAD', '100', '1'),
          (${scratch.orgId}, ${entry}, 2, ${scratch.accounts.bank}, ${child}, '-100', 'CAD', '-100', '1'),
          (${scratch.orgId}, ${entry}, 3, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, '-100', 'CAD', '-100', '1'),
          (${scratch.orgId}, ${entry}, 4, ${scratch.accounts.revenue}, ${child}, '100', 'CAD', '100', '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
    })
    // Reads run in the scratch org's scope: the register issues bare queries
    // with explicit org predicates, which pooled RLS denies outside an
    // explicit scope (unscoped, every scope reads zero rows and totals tie on
    // nothing).
    const { scoped, childScoped, all, none } = await withOrgContext(scratch.orgId, async () => {
      const scoped = await accountRegister(scratch.orgId, scratch.accounts.bank, 100, 0, undefined, new Set([scratch.subsidiaryId]))
      const childScoped = await accountRegister(scratch.orgId, scratch.accounts.bank, 100, 0, undefined, new Set([child]))
      const all = await accountRegister(scratch.orgId, scratch.accounts.bank)
      const none = await accountRegister(scratch.orgId, scratch.accounts.bank, 100, 0, undefined, new Set())
      return { scoped, childScoped, all, none }
    })
    assert.equal(scoped.total, 1)
    assert.equal(scoped.lines.length, 1)
    assert.equal(scoped.balance, '100.0000')
    assert.equal(scoped.lines[0]?.amount, '100.0000')
    assert.equal(childScoped.total, 1)
    assert.equal(childScoped.lines.length, 1)
    assert.equal(childScoped.balance, '-100.0000')
    assert.equal(childScoped.lines[0]?.amount, '-100.0000')
    assert.equal(all.total, 2)
    assert.equal(all.balance, '0.0000')
    assert.equal(none.total, 0)
    assert.equal(none.lines.length, 0)
  } finally { await withBypass(() => dropScratchOrg(scratch.orgId)) }
})
