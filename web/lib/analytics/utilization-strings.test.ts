import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import {
  englishUtilizationStrings,
  utilizationStrings,
} from './utilization-strings.ts'

/**
 * Utilization sentences resolve through the message catalogs. The rolling
 * history-period labels, the two company alerts and the `Unknown` / `No
 * Title` display fallbacks were hardcoded English in utilization-data.ts.
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
  const s = englishUtilizationStrings
  assert.equal(s.monthLabel('2026-03'), "Mar '26")
  assert.equal(s.displayGroupName(null), 'Unknown')
  assert.equal(s.displayGroupName('Ops'), 'Ops')
  assert.equal(s.displayEmployeeTitle(null), 'No Title')
  assert.equal(s.displayEmployeeTitle('No Title'), 'No Title')
  assert.equal(s.displayEmployeeTitle('MECH:Foreman'), 'MECH:Foreman')
  assert.equal(s.displayDepartmentName(undefined), 'Unknown')
  assert.equal(s.displayDepartmentName('Ops'), 'Ops')
  assert.deepEqual(s.alertBelowTarget(70), { type: 'warning', message: 'Billable % below 70% target' })
  assert.deepEqual(s.alertCostSpike('$1,200'), { type: 'danger', message: 'Non-billable cost spiked by $1,200' })
})

test('the French catalog renders French alerts and fallbacks', () => {
  const s = utilizationStrings(catalogTranslator('fr'), 'fr')
  assert.equal(s.monthLabel('2026-03'), "mars '26")
  assert.equal(s.displayGroupName(null), 'Inconnu')
  assert.equal(s.displayEmployeeTitle('No Title'), 'Sans titre')
  assert.equal(s.displayDepartmentName(undefined), 'Inconnu')
  assert.deepEqual(s.alertBelowTarget(70), { type: 'warning', message: 'Part facturable sous la cible de 70 %' })
  assert.deepEqual(s.alertCostSpike('1 200 $'), { type: 'danger', message: 'Le coût non facturable a bondi de 1 200 $' })
})

test('the English default matches the en catalog rendering', () => {
  const def = englishUtilizationStrings
  const en = utilizationStrings(catalogTranslator('en'), 'en')
  assert.equal(def.monthLabel('2026-03'), en.monthLabel('2026-03'))
  assert.equal(def.displayGroupName(null), en.displayGroupName(null))
  assert.equal(def.displayEmployeeTitle('No Title'), en.displayEmployeeTitle('No Title'))
  assert.equal(def.displayDepartmentName(undefined), en.displayDepartmentName(undefined))
  assert.deepEqual(def.alertBelowTarget(70), en.alertBelowTarget(70))
  assert.deepEqual(def.alertCostSpike('$1,200'), en.alertCostSpike('$1,200'))
})

test('every locale renders the alerts without falling back to English', () => {
  const en = utilizationStrings(catalogTranslator('en'), 'en')
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const s = utilizationStrings(catalogTranslator(locale), locale)
    assert.notEqual(s.monthLabel('2026-03'), en.monthLabel('2026-03'), `${locale} monthLabel must not be English fallback`)
    assert.notEqual(s.displayEmployeeTitle('No Title'), en.displayEmployeeTitle('No Title'), `${locale} noTitle must not be English fallback`)
    assert.notEqual(s.alertBelowTarget(70).message, en.alertBelowTarget(70).message, `${locale} belowTarget must not be English fallback`)
    assert.notEqual(s.alertCostSpike('$1,200').message, en.alertCostSpike('$1,200').message, `${locale} costSpike must not be English fallback`)
  }
})
