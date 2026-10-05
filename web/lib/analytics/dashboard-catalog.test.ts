import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILT_IN_REPORT_DEFINITION_MAP, validateCustomQuery } from '@openbooks/reports'
import { ANALYTICS_DASHBOARDS, ANALYTICS_DASHBOARD_MAP, ANALYTICS_GROUPS } from './dashboard-catalog'

test('the analytics library has unique, runnable sources and complete group ownership', () => {
  assert.equal(new Set(ANALYTICS_DASHBOARDS.map((dashboard) => dashboard.slug)).size, ANALYTICS_DASHBOARDS.length)
  for (const dashboard of ANALYTICS_DASHBOARDS) {
    assert.equal(ANALYTICS_DASHBOARD_MAP[dashboard.slug], dashboard)
    assert.ok(ANALYTICS_GROUPS.includes(dashboard.group), dashboard.slug)
    if (dashboard.reportSlug) {
      const report = BUILT_IN_REPORT_DEFINITION_MAP[dashboard.reportSlug]
      assert.ok(report, `${dashboard.slug}: its Reports hub source must exist`)
      validateCustomQuery(report.query)
    } else assert.ok(dashboard.titleKey, `${dashboard.slug}: native dashboard title must be declared`)
  }
})

test('industry assignments do not replace capability gates or unrestricted controls', () => {
  assert.equal(ANALYTICS_DASHBOARD_MAP['utilization']?.feature, 'timeTracking')
  assert.equal(ANALYTICS_DASHBOARD_MAP['resource-capacity']?.permission, 'resourcing.read')
  assert.equal(ANALYTICS_DASHBOARD_MAP['sentinel']?.unrestricted, true)
  assert.equal(ANALYTICS_DASHBOARD_MAP['grant-portfolio']?.unrestricted, true)
  assert.deepEqual(ANALYTICS_DASHBOARD_MAP['financial-health']?.industries, [])
  assert.deepEqual(ANALYTICS_DASHBOARD_MAP['production']?.industries, ['manufacturing'])
})
