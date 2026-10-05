import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ANALYTICS_DASHBOARDS, ANALYTICS_DASHBOARD_MAP, ANALYTICS_GROUPS } from './dashboard-catalog'

test('every analytics entry owns a dashboard page rather than a report shortcut', () => {
  assert.equal(new Set(ANALYTICS_DASHBOARDS.map((dashboard) => dashboard.slug)).size, ANALYTICS_DASHBOARDS.length)
  for (const dashboard of ANALYTICS_DASHBOARDS) {
    assert.equal(ANALYTICS_DASHBOARD_MAP[dashboard.slug], dashboard)
    assert.ok(ANALYTICS_GROUPS.includes(dashboard.group), dashboard.slug)
    assert.ok(dashboard.titleKey, `${dashboard.slug}: dashboard copy must be declared`)
    assert.equal('reportSlug' in dashboard, false, `${dashboard.slug}: reports belong in the Reports catalog`)
    assert.equal('reportHref' in dashboard, false, `${dashboard.slug}: report redirects are not dashboards`)
    const page = fileURLToPath(new URL(`../../app/(app)/analytics/${dashboard.slug}/page.tsx`, import.meta.url))
    assert.ok(existsSync(page), `${dashboard.slug}: a dedicated dashboard page must exist`)
    assert.doesNotMatch(readFileSync(page, 'utf8'), /loadReportRun|reportRunSpec/, `${dashboard.slug}: report paper must not masquerade as a dashboard`)
  }
})

test('industry recommendations retain native capability gates and unrestricted controls', () => {
  assert.equal(ANALYTICS_DASHBOARD_MAP['utilization']?.feature, 'timeTracking')
  assert.equal(ANALYTICS_DASHBOARD_MAP['true-cost']?.feature, 'projects')
  assert.equal(ANALYTICS_DASHBOARD_MAP['sentinel']?.unrestricted, true)
  assert.deepEqual(ANALYTICS_DASHBOARD_MAP['financial-health']?.industries, [])
  assert.ok(ANALYTICS_DASHBOARD_MAP['utilization']?.industries.includes('professional_services'))
})
