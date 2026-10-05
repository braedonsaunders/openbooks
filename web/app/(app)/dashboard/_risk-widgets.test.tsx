import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import './_dashboard-render-harness'
import { mountDashboard } from './_dashboard-render-harness'
import type { DashboardMetrics } from './_metrics'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { WidgetCard } = await import('./_widget-views')

const dir = dirname(fileURLToPath(import.meta.url));
const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(dir, '..', '..', '..', 'messages', locale, 'dashboard.json'), 'utf8'),
  ) as Record<string, unknown>;

// The forensic-risk tile reads the shared summary shape: the score Sentinel
// shows, the flagged count, and the exact translated value at risk — never
// re-derived here. The duplicate tile carries the same, plus the configured
// refusal when the floor is unset.
function riskData() {
  return {
    forensicRisk: { score: 42, flagged: 7, value: '1234.56', currency: 'USD', periodLabel: 'July 2026' },
    duplicatePayments: {
      available: true,
      value: { groups: 3, value: '250.00', currency: 'USD', periodLabel: 'July 2026' },
    },
  } as unknown as DashboardMetrics
}

function unconfiguredData() {
  return {
    forensicRisk: { score: 0, flagged: 0, value: '0.00', currency: 'USD', periodLabel: 'July 2026' },
    duplicatePayments: { available: false, reason: 'Set the duplicate minimum in Sentinel \u2192 Configuration' },
  } as unknown as DashboardMetrics
}

test('forensic-risk tile shows the score with the flagged count and value at risk', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-forensic-risk" data={riskData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Forensic risk'), 'the tile title resolves through dashboard.widgets copy')
    assert.ok(html.includes('>42<'), 'the value is the shared summary score, not a re-derivation')
    assert.ok(html.includes('7 flagged'), 'the hint carries the flagged count')
    assert.ok(html.includes('$1,234.56'), 'the hint carries the exact translated value at risk')
    assert.ok(html.includes('July 2026'), 'the hint names the dashboards opening period')
    assert.ok(html.includes('href="/analytics/sentinel"'), 'the tile links to its dashboard')
  } finally {
    await unmount()
  }
})

test('duplicate-payments tile shows the groups with their translated value', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-duplicate-payments" data={riskData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Duplicate payments'), 'the tile title resolves through dashboard.widgets copy')
    assert.ok(html.includes('>3<'), 'the value is the shared duplicate group count')
    assert.ok(html.includes('$250.00'), 'the hint carries the exact duplicate value')
    assert.ok(html.includes('href="/analytics/sentinel"'), 'the tile links to its dashboard')
  } finally {
    await unmount()
  }
})

test('duplicate-payments tile names the missing floor instead of a zero', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-duplicate-payments" data={unconfiguredData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Duplicate payments'), 'the tile keeps its title with no figure')
    assert.ok(html.includes('Set the duplicate minimum'), 'the translated refusal names the remedy')
    assert.ok(!html.includes('>0<'), 'an unconfigured detector never renders a zero that reads as a fact')
  } finally {
    await unmount()
  }
})

test('risk tiles translate their titles in French', async () => {
  const first = await mountDashboard(
    <WidgetCard widgetId="kpi-forensic-risk" data={riskData()} />,
    { dashboard: catalog('fr') },
    'fr',
  )
  try {
    assert.ok(first.host.innerHTML.includes('Risque de fraude'), 'the forensic title translates')
    assert.ok(first.host.innerHTML.includes('signal\u00e9s'), 'the flagged hint translates')
  } finally {
    await first.unmount()
  }
  const second = await mountDashboard(
    <WidgetCard widgetId="kpi-duplicate-payments" data={riskData()} />,
    { dashboard: catalog('fr') },
    'fr',
  )
  try {
    assert.ok(second.host.innerHTML.includes('Paiements en double'), 'the duplicate title translates')
  } finally {
    await second.unmount()
  }
})
