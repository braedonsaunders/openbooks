import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// F-t02-007: dashboard money tiles and the AR open-receivables tile exclude
// future-dated documents (as-of readers) but carried no as-of caption, so a
// clerk who posts sees headline numbers ignore the posting with no visible
// cut-off. The tiles must read the shared cut-off date and label it.
const dashboardViews = readFileSync(
  new URL('./_widget-views.tsx', import.meta.url),
  'utf8',
)
const arCockpit = readFileSync(
  join(
    new URL('./_widget-views.tsx', import.meta.url).pathname,
    '..',
    '..',
    'ar',
    'cockpit',
    'ArCockpit.tsx',
  ),
  'utf8',
)

test('dashboard money tiles label the shared as-of cut-off (F-t02-007)', () => {
  assert.match(
    dashboardViews,
    /data\.asOfDate/,
    'the widget card must read the metrics as-of date',
  )
  assert.match(
    dashboardViews,
    /metricContext\.asOf/,
    'the widget card must render the as-of caption key',
  )
  for (const hint of [
    "withAsOf(t('metricContext.baseCurrency'",
    "withAsOf(t('metricContext.outstanding'))",
    "withAsOf(t('metricContext.pastDue'))",
  ]) {
    assert.ok(
      dashboardViews.includes(hint),
      `the cash/AR/AP tile hints must carry the as-of caption: ${hint}`,
    )
  }
})

test('the AR open-receivables tile labels the position as-of date (F-t02-007)', () => {
  assert.match(
    arCockpit,
    /data\.asOf/,
    'the cockpit must read the position as-of date',
  )
  assert.match(
    arCockpit,
    /stats\.asOf/,
    'the open-receivables tile must render the as-of caption key',
  )
})
