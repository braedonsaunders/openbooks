import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Fleet-8 dx: the Revenue-by-month insight card rendered dark:bg-slate-950
// while every other tile on the dashboard (CardShell lists, MetricTile KPIs)
// renders dark:bg-slate-900 — in dark mode the insight card sat on a visibly
// different background. CardTile must share the dashboard card chrome so it
// stays correct when the theme changes; no hardcoded divergent color.
const cardTile = readFileSync(new URL('./CardTile.tsx', import.meta.url), 'utf8')
const widgetViews = readFileSync(
  new URL('../dashboard/_widget-views.tsx', import.meta.url),
  'utf8',
)

test('insight card tiles share the dashboard card background in both themes', () => {
  for (const token of ['bg-white', 'border-slate-200', 'dark:border-slate-800', 'dark:bg-slate-900']) {
    assert.ok(
      cardTile.includes(token),
      `CardTile must carry the shared card token ${token}`,
    )
  }
  assert.doesNotMatch(
    cardTile,
    /dark:bg-slate-950/,
    'no divergent dark background on the shared card path',
  )
  // The dashboard list shell is the reference chrome — it must name the same
  // dark token, otherwise this test could pass on a jointly-wrong value.
  assert.ok(
    widgetViews.includes('dark:bg-slate-900'),
    'reference: the dashboard CardShell uses dark:bg-slate-900',
  )
})
