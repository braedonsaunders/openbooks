import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createTranslator } from 'next-intl'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { ForecastExcludedNote } = await import('./sections.tsx')

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

const drawerSource = readFileSync(new URL('../OpportunityDrawer.tsx', import.meta.url), 'utf8')
const forecastsViewSource = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')
const opportunitiesViewSource = readFileSync(new URL('../opportunities/view.ts', import.meta.url), 'utf8')
const crmLibSource = readFileSync(new URL('../../../../lib/crm.ts', import.meta.url), 'utf8')

/**
 * UX-03: an undated opportunity contributes $0 to the forecast with no
 * explanation. The drawer must say the date is the forecast prerequisite,
 * and the forecasts page must count the excluded records with a route to
 * them. Accounting values are unchanged — only guidance and a count.
 */
test('UX-03: expected-close field names the forecast prerequisite', () => {
  assert.match(drawerSource, /hint=\{t\('fields\.expectedCloseHint'\)\}/)
  assert.match(drawerSource, /aria-describedby="expected-close-hint"/)
})

test('UX-03: excluded-undated count mirrors the forecast population', () => {
  // Same boundary as opportunity_base (active, open, not omitted) plus the
  // same owner/team/subsidiary scope — otherwise the count names records
  // the KPIs never left out, or misses ones they did.
  assert.match(crmLibSource, /export async function countUndatedForecastExcluded/)
  assert.match(crmLibSource, /and not s\.is_closed and o\.forecast_category <> 'omitted'/)
  assert.match(crmLibSource, /and o\.expected_close_date is null/)
  assert.match(crmLibSource, /crmOpportunityScope\(scope\.allowedSubsidiaryIds\)/)
  assert.match(forecastsViewSource, /countUndatedForecastExcluded\(\{/)
  assert.match(forecastsViewSource, /hasExcludedUndated: excludedUndated > 0/)
  assert.match(forecastsViewSource, /widgetBlock\('forecast-excluded-note'/)
  assert.match(forecastsViewSource, /when: f\('hasExcludedUndated'\)/)
  assert.match(forecastsViewSource, /excludedUndatedHref: '\/crm\/opportunities\?view=board&undated=1'/)
})

test('UX-03: undated board filter selects exactly the excluded population', () => {
  assert.match(opportunitiesViewSource, /pickString\(sp\.undated\) === '1'/)
  assert.match(opportunitiesViewSource, /and o\.expected_close_date is null/)
})

test('UX-03: exclusion note renders the count with a link to filter them', () => {
  const html = renderToString(
    React.createElement(ForecastExcludedNote, {
      note: 'Excluded: 3 undated opportunities',
      href: '/crm/opportunities?view=board&undated=1',
      linkLabel: 'View undated',
    }),
  )
  assert.ok(html.includes('Excluded: 3 undated opportunities'), 'the count must render')
  assert.ok(html.includes('View undated'), 'the filter link must render')
})

test('UX-03: forecast guidance copy is translated in every locale', async () => {
  const keys = [
    'fields.expectedCloseHint',
    'forecasts.excludedUndated',
    'forecasts.viewUndated',
    'opportunities.undatedOnly',
    'opportunities.showAll',
  ]
  for (const locale of LOCALES) {
    const messages = (await import(`../../../../messages/${locale}/index.ts`)).default as Record<string, unknown>
    const t = createTranslator({ locale, namespace: 'crm', messages: messages as never } as never) as unknown as (
      lookup: string,
      values?: Record<string, number>,
    ) => string
    for (const key of keys) {
      let rendered: string
      try {
        rendered = t(key, { count: 3 })
      } catch (error) {
        assert.fail(`${key} misses in the ${locale} catalog: ${String(error)}`)
      }
      const leaf = key.split('.').pop()!
      assert.ok(
        typeof rendered === 'string' && rendered.length > 0 && !rendered.includes(leaf),
        `${key} must render translated text in ${locale}, got ${JSON.stringify(rendered)}`,
      )
    }
    if (locale !== 'en') {
      const en = (await import('../../../../messages/en/index.ts')).default as Record<string, unknown>
      const enT = createTranslator({ locale: 'en', namespace: 'crm', messages: en as never } as never) as unknown as (
        lookup: string,
        values?: Record<string, number>,
      ) => string
      for (const key of keys) {
        assert.notEqual(t(key, { count: 3 }), enT(key, { count: 3 }), `${locale} must localize ${key}`)
      }
    }
  }
  const en = (await import('../../../../messages/en/index.ts')).default as Record<string, unknown>
  const enT = createTranslator({ locale: 'en', namespace: 'crm', messages: en as never } as never) as unknown as (
    lookup: string,
    values?: Record<string, number>,
  ) => string
  assert.ok(enT('forecasts.excludedUndated', { count: 3 }).includes('3'), 'the count must interpolate')
  assert.equal(enT('fields.expectedCloseHint'), 'Opportunities without an expected close date are excluded from the forecast.')
})
