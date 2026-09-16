import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import {
  englishSpendVelocityStrings,
  spendVelocityStrings,
} from './spend-velocity-strings.ts'

/**
 * Spend-velocity insight sentences resolve through the message catalogs.
 *
 * The loader used to hardcode every title/message/action in English
 * (spend-velocity-data.ts). Localized dashboards pass a catalog-backed bundle;
 * direct callers (tests, assistant tools) keep the English default, so their
 * output is byte-identical to before.
 */

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

test('the English default pins the exact legacy sentences', () => {
  const s = englishSpendVelocityStrings
  assert.equal(s.shortMonths.join(' '), 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec')
  assert.deepEqual(s.highGrowth(1), {
    title: 'High Growth Expense Categories',
    message: '1 expense account growing >20%/month',
    action: 'Review spending policies for these categories',
  })
  assert.deepEqual(s.highGrowth(3), {
    title: 'High Growth Expense Categories',
    message: '3 expense accounts growing >20%/month',
    action: 'Review spending policies for these categories',
  })
  assert.equal(s.typeImbalance('bills', 25).message, 'Bills growing 25% faster than other type')
  assert.equal(s.typeImbalance('expenses', 30).message, 'Expense Reports growing 30% faster than other type')
  assert.equal(s.anomalies(1).message, '1 critical anomaly requires investigation')
  assert.equal(s.anomalies(4).message, '4 critical anomalies require investigation')
  assert.equal(s.creep(2).message, '2 accounts showing consistent increases')
  assert.equal(s.concentration(26).message, 'Top expense category accounts for 26% of spend')
  assert.equal(s.zombies(2, '$5K').message, '2 vendors with identical recurring charges ($5K/year)')
  assert.equal(s.fragmentation(3).message, '3 categories with high transaction volume and low avg size')
  assert.equal(s.opexRatio(55).message, 'Operating expenses are 55% of revenue')
  assert.equal(
    s.cliff(12.5, 3.1, 9.4, 4.03).message,
    'PO velocity (12.5%/mo) exceeds SO velocity (3.1%/mo) by 9.4% — PO/SO ratio: 4.03×',
  )
  assert.equal(s.cliffAction(4), 'Cash pressure risk in ~4 months. Review purchase commitments.')
  assert.equal(s.cliffAction(null), 'Monitor purchase velocity and align with sales pipeline.')
  assert.equal(s.seasonalHigh(['Mar', 'Apr']), 'Higher spending typically occurs in Mar, Apr')
  assert.equal(s.seasonalLow(['Jan']), 'Lower spending typically occurs in Jan')
})

test('the French catalog renders French sentences with ICU plurals', () => {
  const s = spendVelocityStrings(catalogTranslator('fr'), 'fr')
  assert.equal(s.shortMonths[2], 'mars')
  assert.equal(s.highGrowth(1).title, 'Catégories de dépenses à forte croissance')
  assert.equal(s.highGrowth(1).message, '1 compte de dépenses en croissance de plus de 20 %/mois')
  assert.equal(s.highGrowth(3).message, '3 comptes de dépenses en croissance de plus de 20 %/mois')
  assert.equal(s.anomalies(1).message, '1 anomalie critique nécessite une investigation')
  assert.equal(s.anomalies(4).message, '4 anomalies critiques nécessitent une investigation')
  assert.equal(s.concentration(26).message, 'La principale catégorie de dépenses représente 26 % des dépenses')
})

test('every locale renders the spend-velocity insights without falling back to English', () => {
  const en = spendVelocityStrings(catalogTranslator('en'), 'en')
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const s = spendVelocityStrings(catalogTranslator(locale), locale)
    assert.equal(s.shortMonths.length, 12, `${locale} needs 12 short month names`)
    assert.ok(
      s.shortMonths.every((m) => m.trim().length > 0) && !s.shortMonths.includes('common.monthsShort.jan'),
      `${locale} month names must resolve`,
    )
    for (const [name, got, want] of [
      ['highGrowth', s.highGrowth(2).message, en.highGrowth(2).message],
      ['anomalies', s.anomalies(2).message, en.anomalies(2).message],
      ['creep', s.creep(2).message, en.creep(2).message],
      ['concentration', s.concentration(26).message, en.concentration(26).message],
      ['zombies', s.zombies(2, '$5K').message, en.zombies(2, '$5K').message],
      ['fragmentation', s.fragmentation(3).message, en.fragmentation(3).message],
      ['opexRatio', s.opexRatio(55).message, en.opexRatio(55).message],
      ['seasonalHigh', s.seasonalHigh(['Mar']), en.seasonalHigh(['Mar'])],
    ] as const) {
      assert.notEqual(got, want, `${locale} ${name} must not be English fallback`)
      assert.ok(!got.includes('spendVelocity.insights'), `${locale} ${name} must resolve a catalog key`)
    }
  }
})
