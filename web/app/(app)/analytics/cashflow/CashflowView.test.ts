import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'

/**
 * Cashflow hub strings resolve through the message catalogs. KPI labels,
 * vitals, panels, table headers, the category footnote, the cockpit footer
 * and the horizon selector were hardcoded English in CashflowView.tsx and
 * HorizonControl.tsx, and the lowest-week date rendered via `en-US`.
 */

const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
const view = stripComments(readFileSync(new URL('./CashflowView.tsx', import.meta.url), 'utf8'))
const horizonControl = readFileSync(new URL('./HorizonControl.tsx', import.meta.url), 'utf8')

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

test('the cashflow view carries no hardcoded English display copy', () => {
  for (const literal of [
    'Current Cash', 'Projected End', 'Lowest Point', 'Cash Burn Rate', 'AR Coverage',
    'Cash Cycle', 'Net Period Flow', 'Cash Runway', 'Cash Flow Bridge', 'Cash Position Forecast',
    'Accounts Receivable', 'Accounts Payable', 'Forecast Categories', 'Ending cash',
    'Category Analysis', 'Outflows (AP)', 'Inflows (AR)', 'Payables', 'Receivables',
    'Cash cockpit', 'AP cockpit', 'Forecast horizon', 'en-US', 'TAB_LABEL',
  ]) {
    assert.equal(view.includes(literal), false, `CashflowView must not hardcode ${JSON.stringify(literal)}`)
  }
  // Bucket codes (Current, 1-30, …) travel with the cash-core data and stay.
  assert.match(view, /BUCKET_COLORS\[b\.label\]/)
})

test('the horizon selector renders from the catalog', () => {
  assert.match(horizonControl, /t\('horizon\.label'\)/)
  assert.match(horizonControl, /t\('horizon\.aria'\)/)
  assert.match(horizonControl, /t\('horizon\.weeks', \{ count: weeks \}\)/)
  assert.doesNotMatch(horizonControl, /4 Weeks/)
  assert.doesNotMatch(horizonControl, />Horizon</)
})

test('the en cashflow catalog pins the exact legacy copy', () => {
  const t = catalogTranslator('en')
  assert.equal(t('cashflow.tabs.overview'), 'Overview')
  assert.equal(t('cashflow.tabs.category'), 'Category Analysis')
  assert.equal(t('cashflow.kpi.currentCash'), 'Current Cash')
  assert.equal(t('cashflow.kpi.netSub', { change: '+$1.2K' }), '+$1.2K net')
  assert.equal(t('cashflow.vitals.burnRate'), 'Cash Burn Rate')
  assert.equal(t('cashflow.vitals.netFlowHint'), 'Inflows − Outflows')
  assert.equal(t('cashflow.vitals.runwayCritical'), 'Critical')
  assert.equal(t('cashflow.panels.forecastCatHint'), 'Non-AR/AP flows configured in the Configuration tab')
  assert.equal(t('cashflow.panels.agingHint', { amount: '$1M', pct: '80%' }), '$1M · 80% current')
  assert.equal(t('cashflow.series.endingCash'), 'Ending cash')
  assert.equal(
    t('cashflow.footnote.text', { flow: t('cashflow.footnote.flowAp'), weeks: 4 }),
    'Predicted payments to vendors over the 4-week horizon, grouped by party. Each amount is scheduled into the week its collection/payment date is predicted.',
  )
  assert.equal(t('cashflow.partyPanel.byParty', { side: t('cashflow.partyPanel.payables') }), 'Payables by Party')
  assert.equal(t('cashflow.horizon.weeks', { count: 1 }), '1 Week')
  assert.equal(t('cashflow.horizon.weeks', { count: 4 }), '4 Weeks')
})

test('every locale renders the cashflow hub without falling back to English', () => {
  const en = catalogTranslator('en')
  const keys = [
    'cashflow.tabs.overview', 'cashflow.kpi.currentCash', 'cashflow.vitals.burnRate',
    'cashflow.panels.bridge', 'cashflow.catTable.category', 'cashflow.toggle.outflowsAp',
    'cashflow.partyTable.party', 'cashflow.footer.cashCockpit', 'cashflow.horizon.label',
  ]
  // Cognates spelled identically to English are still real translations.
  const identicalIn = { 'cashflow.horizon.label': ['fr'] } as Record<string, string[]>
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const t = catalogTranslator(locale)
    for (const key of keys) {
      const got = t(key)
      assert.notEqual(got, key, `${locale} ${key} must exist in the catalog`)
      if (!(identicalIn[key] ?? []).includes(locale)) {
        assert.notEqual(got, en(key), `${locale} ${key} must not be English fallback`)
      }
    }
    assert.doesNotMatch(t('cashflow.horizon.weeks', { count: 4 }), /\{/)
    assert.doesNotMatch(t('cashflow.footnote.text', { flow: 'x', weeks: 4 }), /\{/)
  }
})
