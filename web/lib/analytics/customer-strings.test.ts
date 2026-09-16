import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import {
  customerStrings,
  englishCustomerStrings,
} from './customer-strings.ts'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

/**
 * Customer-intelligence sentences resolve through the message catalogs.
 * Churn factors, recommendation details, score labels and insight
 * title/message/action copy were hardcoded English in customer-data.ts.
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
  const s = englishCustomerStrings
  assert.equal(s.churnInactive(45), 'No activity in 45 days')
  assert.equal(s.churnDeclining, 'Declining engagement')
  assert.equal(s.churnBelowPattern, 'Below typical purchase pattern')
  assert.equal(s.churnSingle, 'Single transaction customer')
  assert.equal(s.churnLowFrequency, 'Low transaction frequency')
  assert.equal(s.recMaintain, 'Continue current engagement strategy')
  assert.equal(s.recFriction(3), 'High friction: 3 credits — address issues immediately')
  assert.equal(s.recOverdue(12, 30), '12 days overdue for order (avg cycle: 30 days)')
  assert.equal(s.recWinBack, 'At risk of churn — immediate outreach needed')
  assert.equal(s.recReprice('12.3'), 'High revenue but low margin (12.3%) — review pricing')
  assert.deepEqual(s.intelligenceScore(90), { label: 'Excellent', grade: 'A' })
  assert.deepEqual(s.intelligenceScore(50), { label: 'Fair', grade: 'C' })
  assert.deepEqual(s.intelligenceScore(20), { label: 'Needs Attention', grade: 'D' })
  assert.equal(
    s.projectedClv('$1M', 3, 5).message,
    '$1M projected CLV over 3 years from 5 customers',
  )
  assert.equal(
    s.churnRisk(2, '$9K').message,
    '2 customers at high/critical churn risk representing $9K revenue',
  )
  assert.equal(s.concentration('100.0', 10000).message, 'Top customer accounts for 100.0% of revenue. HHI: 10000')
  assert.equal(s.growing(2.5, 4).message, '2.5% average monthly growth with 4 new customers')
  assert.equal(s.overdue(7).message, '7 overdue invoices require attention')
})

test('the French catalog renders French sentences with ICU plurals', () => {
  const s = customerStrings(catalogTranslator('fr'), 'fr')
  assert.equal(s.churnInactive(1), 'Aucune activité depuis 1 jour')
  assert.equal(s.churnInactive(45), 'Aucune activité depuis 45 jours')
  assert.equal(s.churnSingle, 'Client à transaction unique')
  assert.equal(s.recFriction(1), 'Friction élevée : 1 crédit — résoudre les problèmes immédiatement')
  assert.equal(s.recFriction(3), 'Friction élevée : 3 crédits — résoudre les problèmes immédiatement')
  assert.equal(s.recOverdue(1, 30), '1 jour de retard pour la commande (cycle moyen : 30 jours)')
  assert.equal(s.intelligenceScore(90).label, 'Excellent')
  assert.equal(s.intelligenceScore(50).label, 'Passable')
  assert.equal(
    s.projectedClv('$1M', 3, 5).message,
    '$1M de CLV projetée sur 3 ans pour 5 clients',
  )
  assert.equal(s.churnRisk(2, '$9K').title, "Alerte risque d'attrition")
  assert.equal(s.concentration('100.0', 10000).message, "Le principal client représente 100.0 % du chiffre d'affaires. HHI : 10000")
  assert.equal(s.overdue(1).message, '1 facture en retard nécessite une attention')
  assert.equal(s.displayCustomerName('Unknown'), 'Inconnu')
  assert.equal(s.displayCustomerName('Acme'), 'Acme')
  assert.equal(s.displayJobName('Untitled project'), 'Projet sans titre')
})

test('every locale renders the customer insights without falling back to English', () => {
  const en = customerStrings(catalogTranslator('en'), 'en')
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const s = customerStrings(catalogTranslator(locale), locale)
    for (const [name, got, want] of [
      ['churnInactive', s.churnInactive(45), en.churnInactive(45)],
      ['recWinBack', s.recWinBack, en.recWinBack],
      ['churnRisk', s.churnRisk(2, '$9K').message, en.churnRisk(2, '$9K').message],
      ['concentration', s.concentration('100.0', 10000).message, en.concentration('100.0', 10000).message],
      ['growing', s.growing(2.5, 4).message, en.growing(2.5, 4).message],
      ['overdue', s.overdue(7).message, en.overdue(7).message],
    ] as const) {
      assert.notEqual(got, want, `${locale} ${name} must not be English fallback`)
    }
  }
})
