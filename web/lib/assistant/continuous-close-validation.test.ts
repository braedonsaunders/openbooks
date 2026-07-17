import assert from 'node:assert/strict'
import test from 'node:test'
import { validateFinanceNarrative, type NarrativeForValidation } from './continuous-close-validation'

const evidence = {
  requiredCurrentAgingDate: '2026-07-17',
  aging_ar_current: { totals: { total: 3973582.37 }, href: '/reports/aging?side=ar&asOf=2026-07-17' },
  aging_ap_current: { totals: { total: 666692.88 }, href: '/reports/aging?side=ap&asOf=2026-07-17' },
  profit_and_loss: { href: '/reports/pnl?from=2026-05-01&to=2026-05-31' },
}

function narrative(overrides: Partial<NarrativeForValidation> = {}): NarrativeForValidation {
  return {
    title: 'Management summary',
    executiveSummary: 'Current AR is $3,973,582.37 and current AP is $666,692.88.',
    highlights: [], risks: [], recommendations: [], sections: [],
    citations: [
      { label: 'AR aging', href: '/reports/aging?side=ar&asOf=2026-07-17' },
      { label: 'AP aging', href: '/reports/aging?side=ap&asOf=2026-07-17' },
    ],
    ...overrides,
  }
}

test('accepts exact current aging totals and governed citations', () => {
  assert.deepEqual(validateFinanceNarrative(narrative(), evidence), [])
})

test('rejects stale aging dates, missing exact totals, and invented citations', () => {
  const issues = validateFinanceNarrative(narrative({
    executiveSummary: 'AR and AP require attention.',
    citations: [
      { label: 'AR aging', href: '/reports/aging?side=ar&asOf=2026-05-31' },
      { label: 'AP aging', href: '/reports/aging?side=ap&asOf=2026-07-17' },
      { label: 'Invented', href: '/reports/not-a-real-source' },
    ],
  }), evidence)
  assert.ok(issues.includes('missing_current_ar_citation'))
  assert.ok(issues.includes('wrong_ar_aging_date'))
  assert.ok(issues.includes('missing_exact_ar_total'))
  assert.ok(issues.includes('missing_exact_ap_total'))
  assert.ok(issues.includes('unsupported_citation:/reports/not-a-real-source'))
})
