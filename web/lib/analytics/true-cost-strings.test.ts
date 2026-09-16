import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import {
  englishTrueCostStrings,
  trueCostStrings,
} from './true-cost-strings.ts'
import { calculateFormulaCategoryData, calculateScenario } from './true-cost-engine.ts'

/**
 * True Cost sentences resolve through the message catalogs. Rate-engine
 * scenario insights, the formula-category error, the native time-category
 * name, the seeded profile name and month labels were hardcoded English in
 * true-cost-engine.ts / true-cost-data.ts.
 */

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

const CUR = { currentRate: 50, currentExpense: 5000, currentHours: 100, currentUtilization: 0.7, fringeRate: 0.25 }

test('the English default pins the exact legacy sentences', () => {
  const s = englishTrueCostStrings
  assert.equal(s.monthLabel('2026-03'), "Mar '26")
  assert.equal(s.timeCategoryName, 'Non-Billable Time')
  assert.equal(s.formulaError, 'Invalid formula result')
  assert.equal(s.displayEmployeeName('Unknown'), 'Unknown')
  assert.equal(s.displayEmployeeName('Acme'), 'Acme')
  assert.equal(s.displayProfileName('Default'), 'Default')
  assert.equal(s.displayProfileName('Mine'), 'Mine')
  assert.equal(
    s.scenarioHire(2, '75', 130),
    'Adding 2 employee(s) at 75% utilization adds 130 monthly billable hours.',
  )
  assert.equal(
    s.scenarioTerminate(1, '$500', 173.33),
    'Reducing 1 employee(s) saves $500 in overhead but loses 173.33 billable hours.',
  )
  assert.equal(
    s.scenarioWinContract(500),
    'Winning contract adds 500 monthly hours, spreading overhead across more volume.',
  )
  assert.equal(
    s.scenarioLoseContract(250.5),
    'Losing contract removes 250.5 monthly hours, concentrating overhead on fewer hours.',
  )
  assert.equal(s.scenarioCostChange('decrease', '$1,000'), 'Reducing $1,000 in overhead costs.')
  assert.equal(s.scenarioCostChange('increase', '$200'), 'Adding $200 in overhead costs.')
  assert.equal(
    s.scenarioUtilizationChange('70', '80', 'up'),
    'Changing utilization from 70% to 80% increases billable hours.',
  )
  assert.equal(
    s.scenarioUtilizationChange('80', '70', 'down'),
    'Changing utilization from 80% to 70% decreases billable hours.',
  )
})

test('the engine threads the bundle: scenarios and formula errors localize', () => {
  const en = englishTrueCostStrings
  const fr = trueCostStrings(catalogTranslator('fr'), 'fr')
  const hire = calculateScenario({ scenarioType: 'hire', employeeCount: 2 }, CUR, (v) => `$${v}`, en)
  assert.equal(hire.insight, 'Adding 2 employee(s) at 75% utilization adds 260 monthly billable hours.')
  const hireFr = calculateScenario({ scenarioType: 'hire', employeeCount: 2 }, CUR, (v) => `$${v}`, fr)
  assert.equal(hireFr.insight, 'Ajouter 2 employés à 75 % d\'utilisation ajoute 260 heures facturables mensuelles.')
  const winFr = calculateScenario({ scenarioType: 'win_contract', annualHours: 6000 }, CUR, (v) => `$${v}`, fr)
  assert.equal(winFr.insight, 'Gagner ce contrat ajoute 500 heures mensuelles et répartit les frais généraux sur un plus grand volume.')
  const costFr = calculateScenario({ scenarioType: 'cost_change', changeType: 'decrease', amount: 1000 }, CUR, (v) => `$${v}`, fr)
  assert.equal(costFr.insight, 'Réduire les frais généraux de $1000.')
  const bases = {
    hours: { total: 200, totalBilled: 100, byDept: {} },
    laborDollars: { total: 0, byDept: {} },
    headcount: { total: 0, byDept: {} },
    revenue: { total: 0, byDept: {} },
    directCost: { total: 0, byDept: {} },
    squareFeet: { total: 0, byDept: {} },
    units: { total: 0, byDept: {} },
    custom: { total: 0, byDept: {} },
    monthCount: 1,
  }
  const bad = calculateFormulaCategoryData({ formula: '1/0' }, {}, 'billed_hours', [], bases)
  assert.equal(bad.error, 'Invalid formula result')
  const badFr = calculateFormulaCategoryData({ formula: '1/0' }, {}, 'billed_hours', [], bases, fr)
  assert.equal(badFr.error, 'Résultat de formule invalide')
})

test('the French catalog renders French scenarios with ICU plurals', () => {
  const s = trueCostStrings(catalogTranslator('fr'), 'fr')
  assert.equal(s.scenarioHire(1, '75', 130), 'Ajouter 1 employé à 75 % d\'utilisation ajoute 130 heures facturables mensuelles.')
  assert.equal(s.scenarioTerminate(2, '500 $', 346.67), 'Réduire 2 employés économise 500 $ de frais généraux mais fait perdre 346.67 heures facturables.')
  assert.equal(s.scenarioCostChange('increase', '200 $'), 'Augmenter les frais généraux de 200 $.')
  assert.equal(s.scenarioUtilizationChange('80', '70', 'down'), 'Faire passer l\'utilisation de 80 % à 70 % réduit les heures facturables.')
  assert.equal(s.timeCategoryName, 'Temps non facturable')
  assert.equal(s.displayEmployeeName('Unknown'), 'Inconnu')
  assert.equal(s.displayProfileName('Default'), 'Par défaut')
})

test('the English default matches the en catalog except the legacy (s) plurals', () => {
  const def = englishTrueCostStrings
  const en = trueCostStrings(catalogTranslator('en'), 'en')
  const cases: Array<[string, (s: typeof en) => unknown]> = [
    ['month', (s) => s.monthLabel('2026-03')],
    ['timeCategory', (s) => s.timeCategoryName],
    ['formulaError', (s) => s.formulaError],
    ['unknown', (s) => s.displayEmployeeName('Unknown')],
    ['named', (s) => s.displayEmployeeName('Acme')],
    ['defaultProfile', (s) => s.displayProfileName('Default')],
    ['renamedProfile', (s) => s.displayProfileName('Mine')],
    ['win', (s) => s.scenarioWinContract(500)],
    ['lose', (s) => s.scenarioLoseContract(250.5)],
    ['costDown', (s) => s.scenarioCostChange('decrease', '$1,000')],
    ['costUp', (s) => s.scenarioCostChange('increase', '$200')],
    ['utilUp', (s) => s.scenarioUtilizationChange('70', '80', 'up')],
    ['utilDown', (s) => s.scenarioUtilizationChange('80', '70', 'down')],
  ]
  for (const [name, run] of cases) {
    assert.deepEqual(run(def), run(en), `${name}: default must equal en catalog rendering`)
  }
  // Documented improvement, not parity: the catalog renders proper plurals
  // where the legacy engine wrote `employee(s)`.
  assert.equal(en.scenarioHire(1, '75', 130), 'Adding 1 employee at 75% utilization adds 130 monthly billable hours.')
  assert.equal(en.scenarioTerminate(2, '$500', 100), 'Reducing 2 employees saves $500 in overhead but loses 100 billable hours.')
})

test('every locale renders the scenarios without falling back to English', () => {
  const en = trueCostStrings(catalogTranslator('en'), 'en')
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const s = trueCostStrings(catalogTranslator(locale), locale)
    for (const [name, got, want] of [
      ['hire', s.scenarioHire(2, '75', 130), en.scenarioHire(2, '75', 130)],
      ['win', s.scenarioWinContract(500), en.scenarioWinContract(500)],
      ['cost', s.scenarioCostChange('decrease', '$1,000'), en.scenarioCostChange('decrease', '$1,000')],
      ['util', s.scenarioUtilizationChange('70', '80', 'up'), en.scenarioUtilizationChange('70', '80', 'up')],
      ['timeCategory', s.timeCategoryName, en.timeCategoryName],
      ['formulaError', s.formulaError, en.formulaError],
    ] as const) {
      assert.notEqual(got, want, `${locale} ${name} must not be English fallback`)
    }
  }
})
