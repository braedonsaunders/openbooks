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

const dir = dirname(fileURLToPath(import.meta.url))
const catalog = (locale: string, ns: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(dir, '..', '..', '..', 'messages', locale, `${ns}.json`), 'utf8'),
  ) as Record<string, unknown>
const messages = (locale: string): Record<string, unknown> => ({
  dashboard: catalog(locale, 'dashboard'),
  analytics: catalog(locale, 'analytics'),
})

function vendorData(): DashboardMetrics {
  return {
    concentrationHhi: { available: true, value: 1850 },
    concentrationTop5Share: { available: true, value: 0.42 },
    concentrationBand: 'moderate',
    vendorOnTimeRate: { available: true, value: 0.95 },
    vendorOnTimeGoodRate: 60,
    vendorAvgDaysToPay: { available: true, value: 21 },
    vendorLateSpend: { available: true, value: '100.0000' },
    vendorUnratedCount: { available: true, value: 0 },
    spendOpenAlerts: { available: true, value: 7 },
    spendSavingsPotential: { available: true, value: '5432.1090' },
    vendorPeriodLabel: 'Jul 2026',
  } as unknown as DashboardMetrics
}

test('vendor concentration tile shows the shared HHI figure and its band', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-vendor-concentration" data={vendorData()} />,
    messages('en'),
  )
  try {
    assert.ok(host.textContent?.includes('Vendor concentration'))
    assert.ok(host.textContent?.includes('1,850'), `HHI must render grouped, got:\n${host.textContent}`)
    assert.ok(host.textContent?.includes('Top 5: 42%'), `top-5 share must ride the hint, got:\n${host.textContent}`)
  } finally {
    await unmount()
  }
})

test('vendor payment tile reads the shared on-time rate with its context', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-vendor-payment-performance" data={vendorData()} />,
    messages('en'),
  )
  try {
    assert.ok(host.textContent?.includes('95%'), `on-time rate must render, got:\n${host.textContent}`)
    assert.ok(host.textContent?.includes('21'), `average days must ride the hint, got:\n${host.textContent}`)
    // 95% against the 60% good mark reads healthy.
    assert.ok(host.innerHTML.includes('bg-emerald-500'), `a good book must tone emerald, got:\n${host.innerHTML}`)
  } finally {
    await unmount()
  }
  // 40% against the same mark reads poor, never green.
  const poor = vendorData()
  poor.vendorOnTimeRate = { available: true, value: 0.4 }
  const bad = await mountDashboard(
    <WidgetCard widgetId="kpi-vendor-payment-performance" data={poor} />,
    messages('en'),
  )
  try {
    assert.ok(bad.host.innerHTML.includes('bg-rose-500'), `a poor book must tone rose, got:\n${bad.host.innerHTML}`)
  } finally {
    await bad.unmount()
  }
})

test('an unrated vendor book names the state instead of a rate', async () => {
  const data = vendorData()
  const unrated = {
    ...data,
    vendorOnTimeRate: { available: false, reason: 'No payment history yet' },
    vendorAvgDaysToPay: { available: false, reason: 'No payment history yet' },
  } as unknown as DashboardMetrics
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-vendor-payment-performance" data={unrated} />,
    messages('en'),
  )
  try {
    assert.ok(host.textContent?.includes('Unrated'), `unrated must be named, got:\n${host.textContent}`)
    assert.ok(host.textContent?.includes('No payment history yet'))
  } finally {
    await unmount()
  }
})

test('spend velocity tile shows the shared alert count and savings', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-spend-velocity" data={vendorData()} />,
    messages('en'),
  )
  try {
    assert.ok(host.textContent?.includes('Spend velocity'))
    assert.ok(host.textContent?.includes('$5,432.11'), `savings must render as money, got:\n${host.textContent}`)
  } finally {
    await unmount()
  }
})

test('an unconfigured detector keeps its refusal on the spend tile', async () => {
  const data = vendorData()
  const refused = {
    ...data,
    spendOpenAlerts: { available: false, reason: 'Set the fragmentation size cap in Spend Velocity → Configuration' },
  } as unknown as DashboardMetrics
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-spend-velocity" data={refused} />,
    messages('en'),
  )
  try {
    assert.ok(
      host.textContent?.includes('Set the fragmentation size cap in Spend Velocity → Configuration'),
      `the refusal must reach the tile, got:\n${host.textContent}`,
    )
  } finally {
    await unmount()
  }
})
