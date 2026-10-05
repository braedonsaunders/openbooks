import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ANALYTICS_CONFIG, cleanConfigValues, type AnalyticsConfigSpec, type AnalyticsDashboard } from './config-spec'

/**
 * The threshold spec is the only description of every analytics knob: the
 * editor renders it, the API validates against it and the loaders read it.
 * A ladder or section naming an undeclared field silently drops a rule or a
 * field from the editor, and a label key missing from the catalog renders a
 * raw path — so every declaration must resolve.
 */
const en = JSON.parse(readFileSync(new URL('../../messages/en/analytics.json', import.meta.url), 'utf8')) as Record<string, unknown>
const ap = JSON.parse(readFileSync(new URL('../../messages/en/ap.json', import.meta.url), 'utf8')) as Record<string, unknown>
const catalog: Record<string, unknown> = { analytics: en, ap }
function resolves(key: string): boolean {
  let node: unknown = catalog
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

for (const [dashboard, raw] of Object.entries(ANALYTICS_CONFIG)) {
  const spec = raw as AnalyticsConfigSpec
  const declared = new Set(spec.fields.map((f) => f.key))
  test(`${dashboard}: ladders and sections name declared fields, each field at most once`, () => {
    for (const ladder of spec.ordered ?? []) {
      assert.deepEqual(ladder.filter((k) => !declared.has(k)), [], `${dashboard} ladder ${ladder.join(' < ')} names undeclared fields`)
    }
    const seen = new Set<string>()
    for (const group of spec.groups ?? []) {
      assert.deepEqual(group.fields.filter((k) => !declared.has(k)), [], `${dashboard} section ${group.labelKey} names undeclared fields`)
      for (const k of group.fields) {
        assert.ok(!seen.has(k), `${dashboard} field ${k} appears in two sections`)
        seen.add(k)
      }
    }
  })
  test(`${dashboard}: every label, help and section heading exists in English`, () => {
    const keys = [
      ...spec.fields.flatMap((f) => [f.labelKey, f.helpKey]),
      ...(spec.groups ?? []).map((g) => g.labelKey),
    ]
    assert.deepEqual(keys.filter((k) => !resolves(k)), [], `${dashboard} catalog keys missing from messages/en`)
  })
  test(`${dashboard}: the declared defaults pass the spec's own write validation`, () => {
    assert.doesNotThrow(() => cleanConfigValues(dashboard as AnalyticsDashboard, spec.defaults))
  })
}

test('sentinel: set ladder rungs must ascend past unset rungs', () => {
  const base = ANALYTICS_CONFIG.sentinel.defaults as Record<string, unknown>
  assert.doesNotThrow(() =>
    cleanConfigValues('sentinel', { ...base, moderateRiskAmount: '1000.0000', highRiskAmount: '', criticalRiskAmount: '25000.0000' }),
  )
  assert.throws(
    () => cleanConfigValues('sentinel', { ...base, moderateRiskAmount: '50000.0000', highRiskAmount: '', criticalRiskAmount: '1000.0000' }),
    /must be greater than/,
  )
})
