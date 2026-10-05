import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { vendorStrings } = await import('./vendor-strings.ts')
const { vendorData } = await import('./vendor-data.ts')

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

const D = '2026-07-14'
const JULY = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

/**
 * One CAD bill in July: the July spend-month label renders and the named
 * vendor passes through while the month label uses the request locale.
 */
test('vendor month labels render in the request locale', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const vend = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${vend}, ${org.orgId}, 'vendor', 'Acme', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into vendor_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${vend})`)
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'BILL-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${vend}, '100', 'CAD', '100', '1'),
               (${randomUUID()}, ${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${vend}, '-100', 'CAD', '-100', '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    })
    await withOrgContext(org.orgId, async () => {
      const fr = vendorStrings(catalogTranslator('fr'), 'fr')
      const localized = await vendorData(JULY, org.orgId, null, fr)
      const julyFr = localized.monthly.find((m) => m.month === '2026-07')!
      assert.equal(julyFr.label, "juil. '26")
      assert.equal(localized.rows[0]?.name, 'Acme')
      assert.equal(julyFr.spend, "100.0000")
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
