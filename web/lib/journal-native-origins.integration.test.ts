import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * The Journal list shows journal-kind documents plus GL-native engine
 * journals with no subledger document (closing, allocation, revaluation,
 * FX revaluation, elimination, disposal, …). Every GL-native origin the
 * engines actually post must be visible: a posted journal the list hides
 * breaks the ledger's audit trail (reports tie, the journal does not show
 * the entry).
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext } = (await import(root + 'engine/src/db.ts')) as typeof import('@openbooks/engine/src/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { JOURNAL_ENTRY_TABLE } = (await import(root + 'web/lib/customization/entity-list-query/journal-entries.ts')) as typeof import('./customization/entity-list-query/journal-entries.ts')

/** GL-native standalone origins posted by the engines (no source document). */
const NATIVE_ORIGINS = [
  'manual',
  'revaluation',
  'fx_revaluation',
  'intercompany',
  'disposal',
  'inventory',
  'lease',
  'tax_provision',
  'overhead_applied',
  'payroll_variance',
  'labor_burden',
  'depreciation',
  'revenue_recognition',
  'fx_settlement',
  'translation',
  // Migration true-ups (TRUEUP-*) are standalone engine journals (F-t12-014):
  // posted but invisible in /journal while Origin=All.
  'migration',
]

test('journal list shows every GL-native engine origin', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const actorId = (await seedFlowActors(org.orgId)).adminId
      for (const origin of NATIVE_ORIGINS) {
        const entryId = randomUUID()
        const tag = `NATIVE-${origin.replace(/_/g, '-').toUpperCase()}`
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${tag}, ${org.date}, ${org.periodId},
                  ${tag}, 'draft', ${origin}, ${actorId}, ${actorId})`)
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
          values
            (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 10.00, 'CAD', 10.00, 1, false),
            (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, -10.00, 'CAD', -10.00, 1, false)`)
        await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${entryId}`)
      }
    })
    const visible = await withBypassContext(async () => db.execute<{ entry_number: string; origin: string }>(sql`
      select e.entry_number, e.origin from ${sql.raw(JOURNAL_ENTRY_TABLE)} as e
       where e.org_id = ${org.orgId} and e.entry_number like 'NATIVE-%'`))
    const seen = new Map(visible.rows.map((row) => [row.entry_number, row.origin]))
    const missing: string[] = []
    for (const origin of NATIVE_ORIGINS) {
      const tag = `NATIVE-${origin.replace(/_/g, '-').toUpperCase()}`
      if (seen.get(tag) !== origin) missing.push(origin)
    }
    assert.deepEqual(missing, [], `journal list hides GL-native origins: ${missing.join(', ')}`)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
