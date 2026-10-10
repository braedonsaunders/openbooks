import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../testing/stub-modules.ts'

// The Analytics hub's Utilization card reuses the dashboard loader, whose
// history periods arrive newest first. The card's trend and its "from → to"
// subtitle must read oldest → newest, like the dashboard's own chart.
stubModules({
  extra: {
    'server-only': '',
    '../authz-context': 'export async function withAuthzContext(_a, fn) { return fn() } export function requestAuthzContext() { return {} }',
    'next-intl/server': 'export async function getTranslations() { return (key) => key }',
    '../money-server': "export async function getMoneyFormatter() { return { locale: 'en', money: (v) => String(v) } }",
    '../money-format': 'export function formatDecimal(_locale, value) { return String(value) }',
    '../chart-number': 'export function toChartNumber(value) { return Number(value) }',
    '../authz': "export class ForbiddenError extends Error {} export async function requirePermission() { return { user: { orgId: 'org-1' } } }",
    './dashboard-access': 'export async function analyticsDashboardAvailable() { return true }',
    './query-params': 'export function analyticsSourceQuery(sp) { return sp }',
    './preview-cache': 'export async function analyticsCacheIdentity() { return {} } export async function cachedAnalyticsPreview(_a, _s, _q, build) { return build() }',
    './read-context': 'export function currentAnalyticsRead() { return { observedAt: 0 } } export async function withAnalyticsRead(_c, fn) { return fn() }',
    '../../app/(app)/analytics/utilization/view': `
      export async function loadUtilization() {
        return {
          periodLabel: 'Jul 2026',
          data: {
            history: { periodMonths: 1, periods: [
              { label: "Jun '26", companyPct: 70 },
              { label: "May '26", companyPct: 60 },
              { label: "Apr '26", companyPct: 50 },
            ] },
            company: { range: { hours: 10, billableHours: 7, percentBilled: 70, nonBillableCost: '0' } },
          },
        }
      }
    `,
  },
})

const { analyticsDashboardPreview } = await import('./dashboard-preview.ts')

test('the Utilization card trend and range read oldest to newest', async () => {
  const preview = await analyticsDashboardPreview(
    { slug: 'utilization' } as Parameters<typeof analyticsDashboardPreview>[0],
    {},
    'org-1',
  )
  const chart = preview.chart as { kind: string; points: number[]; from: string; to: string }
  assert.equal(chart.kind, 'sparkline')
  assert.equal(chart.from, "Apr '26", 'the range starts at the oldest period')
  assert.equal(chart.to, "Jun '26", 'the range ends at the newest period')
  assert.deepEqual(chart.points, [50, 60, 70], 'points follow the same chronology as the labels')
})
