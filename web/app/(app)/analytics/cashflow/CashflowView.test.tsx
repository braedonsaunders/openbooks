import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from 'next-intl'
import type { WeekRow } from '../../../../lib/cash/core'
import type { CashflowData } from '../../../../lib/analytics/cashflow-data'

/**
 * Cashflow hub strings resolve through the message catalogs: KPI labels,
 * vitals, panels, table headers, the cockpit footer and the horizon
 * selector render translated copy, and the lowest-week date follows the
 * operator locale instead of a hardcoded `en-US`.
 */

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__cfRouter}export function usePathname(){return \'/analytics/cashflow\'}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    return next(specifier, context)
  },
})

declare global {
  var __cfRouter: { push(url: string): void; refresh(): void; replace(url: string): void } | undefined
}

const React = await import('react')
Object.assign(globalThis, { React })
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/fr')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { CashflowView } = await import('./CashflowView')
const { HorizonControl } = await import('./HorizonControl')

function renderFr(ui: ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">{ui}</MoneyProvider>
    </NextIntlClientProvider>,
  )
}

function week(): WeekRow {
  return {
    weekStart: '2026-09-13',
    weekEnd: '2026-09-19',
    label: 'Sep 13 – Sep 19',
    inflow: '1000.0000',
    outflow: '400.0000',
    net: '600.0000',
    startingCash: '5000.0000',
    endingCash: '5600.0000',
    arEntries: [],
    apEntries: [],
    arTotal: '1000.0000',
    apTotal: '400.0000',
    arCount: 40,
    apCount: 20,
    dynamicInflow: '0.0000',
    dynamicOutflow: '0.0000',
    deferredOut: '0.0000',
    apCapacity: null,
  }
}

function side(outstanding: string) {
  return { outstanding, scheduled: '1000.0000', pctCurrent: '0.8000', avgDays: 20, buckets: [] }
}

function fixture(): CashflowData {
  return {
    asOf: '2026-09-13',
    horizonWeeks: 4,
    startingCash: '5000.0000',
    bankAccounts: [],
    weeks: [week()],
    partyTotals: { ar: [], ap: [] },
    summary: {
      startingCash: '5000.0000',
      projectedEnd: '5600.0000',
      totalInflows: '1000.0000',
      totalOutflows: '400.0000',
      netChange: '600.0000',
      lowestCash: '5600.0000',
      lowestWeek: '2026-09-19',
      burnRate: '400.0000',
      runwayWeeks: '14.0000',
      runwayStatus: 'healthy',
      arCoverage: '2.5000',
      dso: 20,
      dpo: 25,
    },
    ar: side('5000.0000'),
    ap: side('3000.0000'),
    categories: [],
    apSettings: { weeklyCap: '0.0000', restrictToSafe: false },
    deferredBeyondHorizon: '0.0000',
    vendorOptions: [],
    accountOptions: [],
  } as unknown as CashflowData
}

test('the cashflow hub renders its chrome from the catalog, not hardcoded English', () => {
  const html = renderFr(<CashflowView data={fixture()} />)
  assert.match(html, /Trésorerie actuelle/, 'Current Cash is French')
  assert.match(html, /Taux de consommation/, 'Cash Burn Rate is French')
  assert.match(html, /Cockpit de trésorerie/, 'the cockpit footer is French')
  assert.match(html, /Aperçu/, 'the overview tab is French')
  for (const leaked of ['Current Cash', 'Cash Burn Rate', 'Cash cockpit', 'Forecast horizon']) {
    assert.doesNotMatch(html, new RegExp(leaked), `${leaked} must not leak English`)
  }
})

test('the lowest-week date follows the operator locale', () => {
  const html = renderFr(<CashflowView data={fixture()} />)
  assert.match(html, /19 sept\./, 'the lowest week renders in French date order')
  assert.doesNotMatch(html, /Sep 19/, 'the US-English date must not leak')
})

test('the horizon selector renders from the catalog', () => {
  globalThis.__cfRouter = { push() {}, refresh() {}, replace() {} }
  const html = renderFr(<HorizonControl value={4} />)
  assert.match(html, /Horizon de prévision/, 'the selector carries the French aria label')
  assert.match(html, /4 semaines/, 'the week counts are French plurals')
  assert.match(html, /13 semaines/, 'every offered horizon is translated')
  assert.doesNotMatch(html, /4 Weeks/, 'the English week count is gone')
  assert.doesNotMatch(html, /Forecast horizon/, 'the English aria is gone')
})

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

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
