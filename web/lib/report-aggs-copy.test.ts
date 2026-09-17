import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { REPORT_AGG_FNS } from '../../packages/reports/src/types.ts'

/**
 * F-t07-005: the builder offered the `latest` aggregation but reports.aggs
 * had no such key in any locale, so the dropdown rendered the raw
 * "reports.aggs.latest" key (plus MISSING_MESSAGE console errors). Every
 * engine aggregate needs a translated label in every locale.
 */
const LOCALES = ['en', 'es', 'fr', 'de', 'ja', 'pt-BR', 'zh'] as const

function aggs(locale: string): Record<string, unknown> {
  const catalog = JSON.parse(readFileSync(new URL(`../messages/${locale}/reports.json`, import.meta.url), 'utf8')) as {
    aggs?: Record<string, unknown>
  }
  assert.ok(catalog.aggs, `${locale} is missing the reports.aggs block`)
  return catalog.aggs
}

test('every engine aggregate has a translated label in every locale', () => {
  const source = aggs('en')
  for (const fn of REPORT_AGG_FNS) {
    assert.ok(typeof source[fn] === 'string' && (source[fn] as string).trim(), `en is missing reports.aggs.${fn}`)
  }
  for (const locale of LOCALES.filter((candidate) => candidate !== 'en')) {
    const block = aggs(locale)
    for (const fn of REPORT_AGG_FNS) {
      // Presence + non-empty only: short labels are legitimately identical
      // across locales (fr/es/de Min/Max), so divergence is not required.
      // A missing key is what renders the raw reports.aggs.* fallback.
      const value = block[fn]
      assert.ok(typeof value === 'string' && value.trim(), `${locale} is missing reports.aggs.${fn}`)
    }
  }
})
