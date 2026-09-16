import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { healthStrings } = await import('./health-strings.ts')
const { healthData } = await import('./health-data.ts')

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
 * Revenue 1000 against opex 600 trips the heavy-overhead rule (>40%) while
 * gross margin stays perfect (healthy-margin rec). Findings, P&L labels and
 * month labels must all render in the request locale.
 */
test('health findings and labels render in the request locale', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      for (const [num, account, amt] of [
        ['REV-1', org.accounts.revenue, '-1000'],
        ['EXP-1', org.accounts.cogs, '600'],
      ] as const) {
        const entry = randomUUID()
        const contra = amt.startsWith('-') ? amt.slice(1) : `-${amt}`
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
          values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${org.orgId}, ${entry}, 1, ${account}, ${org.subsidiaryId}, ${amt}, 'CAD', ${amt}, '1'),
                 (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${contra}, 'CAD', ${contra}, '1')`)
        await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
      }
    })
    await withOrgContext(org.orgId, async () => {
      const fallback = await healthData(JULY, org.orgId, null)
      const titles = fallback.insights.map((i) => i.title)
      assert.ok(titles.includes('Heavy overhead'))
      assert.ok(titles.includes('Healthy gross margin'))
      assert.equal(fallback.pnlSummary.find((l) => l.key === 'cogs')?.label, 'Cost of Goods Sold')
      assert.equal(fallback.marginFlow.find((s) => s.key === 'cogs')?.label, 'COGS')
      assert.equal(fallback.monthly.find((m) => m.month === '2026-07')?.label, "Jul '26")

      const fr = await healthData(JULY, org.orgId, null, healthStrings(catalogTranslator('fr'), 'fr'))
      const frTitles = fr.insights.map((i) => i.title)
      assert.ok(frTitles.includes('Charges fixes lourdes'))
      assert.ok(frTitles.includes('Marge brute saine'))
      assert.equal(fr.pnlSummary.find((l) => l.key === 'cogs')?.label, 'Coût des ventes')
      assert.equal(fr.marginFlow.find((s) => s.key === 'cogs')?.label, 'Coût des ventes')
      assert.equal(fr.monthly.find((m) => m.month === '2026-07')?.label, "juil. '26")
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
