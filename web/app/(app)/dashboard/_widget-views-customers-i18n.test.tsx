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
const catalog = (locale: string, namespace: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(dir, '..', '..', '..', 'messages', locale, `${namespace}.json`), 'utf8'),
  ) as Record<string, unknown>;

const messages = { dashboard: catalog('en', 'dashboard'), analytics: catalog('en', 'analytics') };

function concentrationData() {
  return {
    concentration: {
      available: true,
      value: { hhi: 1840, level: 'moderate', customersFor80Pct: 4, topSharePct: 46 },
    },
  } as unknown as DashboardMetrics
}

function atRiskData() {
  return {
    atRisk: { available: true, value: { count: 2, revenue: '12500.00' } },
  } as unknown as DashboardMetrics
}

function listData() {
  return {
    atRiskCustomers: {
      available: true,
      value: [
        { id: 'c1', name: 'Anchor Co', churnLevel: 'critical', churnScore: 95, revenue: '10000.00' },
        { id: 'c2', name: 'Bravo Ltd', churnLevel: 'high', churnScore: 70, revenue: '2500.00' },
      ],
    },
  } as unknown as DashboardMetrics
}

// The concentration tile states the HHI the dashboard shows, with the level
// and top share in the hint — never a bare level word with no figure.
test('customer concentration renders the HHI with its level and top share', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-customer-concentration" data={concentrationData()} />,
    messages,
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('1,840'), 'the HHI figure renders grouped in the viewer locale')
    assert.ok(html.includes('Moderate'), 'the level resolves through dashboard.concentrationLevels')
    assert.ok(html.includes('46%'), 'the top share renders as a percent')
    assert.ok(!html.includes('concentrationLevels'), 'no raw catalog path renders')
  } finally {
    await unmount()
  }
})

test('customer concentration names its refusal instead of a zero HHI', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard
      widgetId="kpi-customer-concentration"
      data={{ concentration: { available: false, reason: 'Set the weights first' } } as unknown as DashboardMetrics}
    />,
    messages,
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('—'), 'an unavailable figure renders an em dash, never 0')
    assert.ok(html.includes('Set the weights first'), 'the refusal reason renders on the tile')
  } finally {
    await unmount()
  }
})

// The at-risk tile counts customers at or above the high-churn bar and
// states their trailing revenue as money — never a count with no amount.
test('customers at risk renders the count with its trailing revenue', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-customers-at-risk" data={atRiskData()} />,
    messages,
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('2 customers'), 'the count runs the catalog plural rule')
    assert.ok(html.includes('12,500'), 'the trailing revenue renders as money, not a raw string')
  } finally {
    await unmount()
  }
})

// Each at-risk row names the customer with their churn level, churn score
// and trailing revenue; an empty book says so by name.
test('the at-risk list renders each customer with score and revenue', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="list-customers-at-risk" data={listData()} />,
    messages,
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Anchor Co'), 'the customer name renders')
    assert.ok(html.includes('Critical'), 'the churn level resolves through analytics.customer risk copy')
    assert.ok(html.includes('churn score 95'), 'the churn score renders beside its level')
    assert.ok(html.includes('10,000'), 'the trailing revenue renders as money')
    assert.ok(!html.includes('risk.critical'), 'no raw catalog path renders')
  } finally {
    await unmount()
  }
})

test('the at-risk list names an empty book instead of rendering nothing', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard
      widgetId="list-customers-at-risk"
      data={{ atRiskCustomers: { available: true, value: [] } } as unknown as DashboardMetrics}
    />,
    messages,
  )
  try {
    assert.ok(host.innerHTML.length > 0, 'the card shell still renders')
    assert.ok(!host.innerHTML.includes('<li'), 'no rows render for an empty book')
  } finally {
    await unmount()
  }
})
