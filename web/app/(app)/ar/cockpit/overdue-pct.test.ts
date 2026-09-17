import assert from 'node:assert/strict'
import test from 'node:test'
import { overdueOpenPct } from './overdue-pct'

// F-t12-003: the AR header rendered "100%% of open". The overdueSub message
// template already carries the % sign ("{pct}% of open"), so the value fed
// as {pct} must be a bare number — never a pre-suffixed "100%".
test('overdue share is a bare whole-number percent with no sign attached', () => {
  assert.equal(overdueOpenPct('454775.3900', '454775.3900'), '100')
  assert.equal(overdueOpenPct('227387.6950', '454775.3900'), '50')
  assert.equal(overdueOpenPct('0.0000', '454775.3900'), '0')
})

test('zero outstanding never divides: it reports 0, not NaN', () => {
  assert.equal(overdueOpenPct('0.0000', '0.0000'), '0')
  assert.equal(overdueOpenPct('10.0000', '0.0000'), '0')
})

test('rendered subtitle carries exactly one percent sign', () => {
  const template = '{count} invoices · {pct}% of open'
  const rendered = template
    .replace('{count}', '13')
    .replace('{pct}', overdueOpenPct('454775.3900', '454775.3900'))
  assert.equal(rendered, '13 invoices · 100% of open')
  assert.ok(!rendered.includes('%%'))
})
