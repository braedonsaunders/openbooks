import assert from 'node:assert/strict'
import test from 'node:test'

// F2-14b (forecast month labels): the forecast table's future months must
// render in the viewer's locale — "janv." for a French viewer, never a
// pinned English "Jan". The chart is stubbed out; the assertion rides the
// real detail table, which renders the same futureLabels array.
const React = await import('react')
Object.assign(globalThis, { React })
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../../_ui/charts') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function ForecastChart(){return null}',
      }
    }
    return next(specifier, context)
  },
})
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('@/components/money-provider')
const { ForecastTab } = await import('./ForecastTab')
import type { HealthData } from '../../../../../lib/analytics/health-data'

function month(revenue: number, month: string, label: string) {
  return {
    month,
    label,
    revenue,
    cogs: 40,
    grossProfit: 60,
    grossMarginPct: 60,
    opex: 20,
    operatingIncome: 40,
    operatingMarginPct: 40,
    netIncome: 35,
  }
}

const data = {
  monthly: [
    month(100, '2025-10', "Oct '25"),
    month(110, '2025-11', "Nov '25"),
    month(120, '2025-12', "Dec '25"),
  ],
} as unknown as HealthData

function markup(locale: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={{}} timeZone="UTC">
      <MoneyProvider currency="USD">
        <ForecastTab data={data} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
}

test('forecast future months render in the viewer locale (F2-14b)', () => {
  const en = markup('en-US')
  const fr = markup('fr')
  assert.match(en, /Jan/)
  assert.match(fr, /janv/i)
  assert.ok(!fr.includes('>Jan<'), 'no pinned English month may leak into the French table')
})
