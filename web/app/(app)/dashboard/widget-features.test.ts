import assert from 'node:assert/strict'
import test from 'node:test'

const { widgetFeatureKey } = await import('./widget-features.ts')

/**
 * The widget-to-feature map preserves every gate the dashboard enforced
 * before the extraction, and registers the resourcing pulse. The "before"
 * set below is derived once from the two old ad-hoc call sites:
 * default-layout composition fetched payroll, HR and announcements flags,
 * and persona metrics gated its pay, balance, celebration, announcement,
 * headcount and nudge readers on those same keys.
 */
test('widget features preserve the previous gates and register the resourcing pulse', () => {
  const before: Record<string, string> = {
    'pay-tile': 'payroll',
    'balance-tile': 'hrm',
    'celebrations-list': 'hrm',
    'announcements-card': 'homeAnnouncements',
    'team-headcount': 'hrm',
    'team-nudges': 'hrm',
  }
  for (const [widgetId, key] of Object.entries(before)) {
    assert.equal(widgetFeatureKey(widgetId), key, `${widgetId} keeps its ${key} gate`)
  }
  assert.equal(widgetFeatureKey('resourcing-pulse'), 'resourcing')
})

test('ungated widgets resolve to no feature key', () => {
  for (const widgetId of ['personal-actions', 'inbox-list', 'home-upcoming', 'team-quals', 'admin-attention', 'kpi-open-receivables']) {
    assert.equal(widgetFeatureKey(widgetId), null, `${widgetId} carries no single feature key`)
  }
  assert.equal(widgetFeatureKey('no-such-widget'), null)
})
