import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { healthStrings, localizedRatioDefs } = await import('./health-strings.ts')
const { healthData } = await import('./health-data.ts')
const { RATIO_IDS } = await import('./ratio-ids.ts')

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

/**
 * The catalog is the only copy of the ratio definitions: every ratio the
 * engine computes has one in every locale, and the prose is translated.
 */
test('every engine ratio has a catalog definition, translated in every locale', () => {
  const en = localizedRatioDefs(catalogTranslator('en'))
  assert.deepEqual(Object.keys(en).sort(), [...RATIO_IDS].sort())
  assert.equal(localizedRatioDefs(catalogTranslator('fr')).gross_margin?.label, 'Marge brute')
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const defs = localizedRatioDefs(catalogTranslator(locale))
    assert.deepEqual(Object.keys(defs).sort(), [...RATIO_IDS].sort(), `${locale} needs every ratio definition`)
    const enTable: Record<string, Record<string, string>> = { ...en }
    for (const [id, def] of Object.entries(defs)) {
      const enDef = enTable[id]
      assert.ok(enDef, `${locale} ${id} must exist in English`)
      for (const field of ['label', 'formula', 'desc', 'interpret'] as const) {
        assert.ok(def[field].trim().length > 0, `${locale} ${id}.${field} must resolve`)
        assert.ok(!def[field].includes('financialHealth.ratios'), `${locale} ${id}.${field} must resolve a catalog key`)
      }
      // Prose must translate; names/formulas may legitimately coincide
      // across languages ("Rule of 40", "NOPAT", symbols).
      for (const field of ['desc', 'interpret'] as const) {
        assert.notEqual(def[field], enDef[field], `${locale} ${id}.${field} must not be English fallback`)
      }
    }
  }
})
