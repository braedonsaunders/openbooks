import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./BudgetTab.tsx', import.meta.url), 'utf8')

test('budget CSV exports retain decimal money values', () => {
  assert.match(source, /filtered\.map\(\(r\) => \[r\.name, r\.type, r\.budget, r\.actual, r\.variance, /)
  assert.doesNotMatch(source, /Math\.round\(r\.(?:budget|actual|variance)\)/)
})

/**
 * F-t09-004: a revenue shortfall must read "Under", never "Over". The tab
 * needs a style, a label, and a stated tolerance for the new status, or the
 * helper's "under" renders unstyled/untranslated next to a silent rule.
 */
test('budget under-status ships styled, translated, and tolerance-disclosed', () => {
  assert.match(source, /under: 'bg-orange-100/)
  assert.match(source, /t\('toleranceNote'\)/)
  assert.match(source, /r\.status === 'under' \? 'bg-red-500'/)
})

test('budget under-status and tolerance copy exist in every locale catalog', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh']) {
    const catalog = JSON.parse(
      readFileSync(new URL(`../../../../../messages/${locale}/analytics.json`, import.meta.url), 'utf8'),
    ) as { financialHealth?: { budget?: { status?: Record<string, unknown>; toleranceNote?: unknown } } }
    const status = catalog.financialHealth?.budget?.status
    assert.equal(typeof status?.under, 'string', `${locale} needs financialHealth.budget.status.under`)
    assert.ok(String(status?.under).trim(), `${locale} status.under must not be blank`)
    assert.equal(
      typeof catalog.financialHealth?.budget?.toleranceNote,
      'string',
      `${locale} needs financialHealth.budget.toleranceNote`,
    )
  }
})
