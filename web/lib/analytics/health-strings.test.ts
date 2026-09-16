import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import {
  englishHealthStrings,
  healthStrings,
} from './health-strings.ts'

/**
 * Financial-health findings, P&L/margin labels and month labels resolve
 * through the message catalogs. They were hardcoded English in health-data.ts.
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
  const s = englishHealthStrings
  assert.equal(s.monthLabel('2026-03'), "Mar '26")
  assert.equal(s.pnlLine('cogs'), 'Cost of Goods Sold')
  assert.equal(s.pnlLine('netIncome'), 'Net Income')
  assert.equal(s.marginStage('cogs'), 'COGS')
  assert.equal(s.marginStage('excludeOtherIncome'), 'Exclude Other Income')
  assert.deepEqual(s.heavyOverhead('60'), {
    severity: 'issue',
    title: 'Heavy overhead',
    detail: 'Operating expenses are 60% of revenue (>40%).',
  })
  assert.deepEqual(s.gmCritical('12.3', '40'), {
    severity: 'issue',
    title: 'Gross margin critically low',
    detail: 'Gross margin is 12.3% — less than half the 40% target.',
  })
  assert.equal(s.healthyGM.title, 'Healthy gross margin')
  assert.equal(s.rule40('42').detail, 'Growth + margin = 42.')
  assert.equal(s.marginOutlier('Mar', '10.0', '40.0').title, 'Margin outlier in Mar')
  assert.equal(s.displaySegmentName('unassigned', 'Unassigned'), 'Unassigned')
  assert.equal(s.displaySegmentName('dept-1', 'Ops'), 'Ops')
  assert.equal(s.noDA, 'No depreciation/amortization accounts found')
  assert.equal(s.noInterestExpense, 'No interest expense')
  assert.equal(s.perEmployees('$1M', 1), '$1M / 1 employees')
})

test('the ratio no-data notes render in the request locale with ICU plurals', () => {
  const s = healthStrings(catalogTranslator('fr'), 'fr')
  assert.equal(s.noDA, 'Aucun compte de dotations aux amortissements trouvé')
  assert.equal(s.noInterestExpense, "Aucune charge d'intérêts")
  assert.equal(s.perEmployees('$1M', 1), '$1M / 1 salarié')
  assert.equal(s.perEmployees('$1M', 42), '$1M / 42 salariés')
})

test('the French catalog renders French findings and reuses the pnl line names', () => {
  const s = healthStrings(catalogTranslator('fr'), 'fr')
  assert.equal(s.monthLabel('2026-03'), "mars '26")
  assert.equal(s.pnlLine('cogs'), 'Coût des ventes')
  assert.equal(s.marginStage('excludeOtherIncome'), 'Exclure les autres produits')
  assert.deepEqual(s.heavyOverhead('60'), {
    severity: 'issue',
    title: 'Charges fixes lourdes',
    detail: "Les charges d'exploitation représentent 60 % du chiffre d'affaires (>40 %).",
  })
  assert.equal(s.gmCritical('12.3', '40').detail, "La marge brute est de 12.3 % — moins de la moitié de l'objectif de 40 %.")
  assert.equal(s.healthyGM.title, 'Marge brute saine')
  assert.equal(s.displaySegmentName('unassigned', 'Unassigned'), 'Non affecté')
})

test('every locale renders the health findings without falling back to English', () => {
  const en = healthStrings(catalogTranslator('en'), 'en')
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const s = healthStrings(catalogTranslator(locale), locale)
    for (const [name, got, want] of [
      ['heavyOverhead', s.heavyOverhead('60').detail, en.heavyOverhead('60').detail],
      ['gmCritical', s.gmCritical('12.3', '40').detail, en.gmCritical('12.3', '40').detail],
      ['healthyGM', s.healthyGM.detail, en.healthyGM.detail],
      ['pnlLine', s.pnlLine('cogs'), en.pnlLine('cogs')],
      ['monthLabel', s.monthLabel('2026-03'), en.monthLabel('2026-03')],
    ] as const) {
      assert.notEqual(got, want, `${locale} ${name} must not be English fallback`)
    }
  }
})
