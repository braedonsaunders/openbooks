import assert from 'node:assert/strict'
import test from 'node:test'
import { complianceHref, performanceHref, recruitingHref } from './workspace-href'

// F3-55/56/57: drawer hrefs preserve the tab, filter, and setup params and
// only swap the selection keys — closing a drawer returns the operator to
// the same tab/filter/selection context.
test('recruiting row hrefs keep the depth tab and the status filter', () => {
  const href = recruitingHref({ status: 'open', tab: 'interviews' }, { requisition: 'req-1' })
  assert.equal(href, '/hrm/recruiting?status=open&tab=interviews&requisition=req-1')
})

test('recruiting close hrefs clear the selection but keep tab, filter, and setup params', () => {
  const href = recruitingHref({ status: 'open', tab: 'offers', q: 'pipe', f_kind: 'panel' }, {})
  assert.equal(href, '/hrm/recruiting?status=open&tab=offers&q=pipe&f_kind=panel')
  const query = new URLSearchParams(href.split('?')[1])
  assert.equal(query.get('requisition'), null, 'no stale requisition selection rides along')
  assert.equal(query.get('candidate'), null, 'no stale candidate selection rides along')
  assert.equal(query.get('offer'), null, 'no stale offer selection rides along')
})

test('recruiting hrefs collapse to the base path with no params', () => {
  assert.equal(recruitingHref({}, {}), '/hrm/recruiting')
})

test('performance drawer hrefs keep the continuous tab and the segment', () => {
  const open = performanceHref({ status: 'mine', tab: 'retention' }, { cycle: 'cyc-1' })
  assert.equal(open, '/hrm/performance?status=mine&tab=retention&cycle=cyc-1')
  const close = performanceHref({ status: 'mine', tab: 'retention' }, {})
  assert.equal(close, '/hrm/performance?status=mine&tab=retention')
  assert.ok(!close.includes('cycle='), 'closing drops the cycle selection')
  assert.ok(!close.includes('review='), 'closing drops the review selection')
})

test('compliance generate/close hrefs keep the section and kind filter', () => {
  const preserved = { section: 'rates', kind: 'statutory' }
  assert.equal(complianceHref(preserved, { generate: '1' }), '/hrm/compliance?section=rates&kind=statutory&generate=1')
  assert.equal(complianceHref(preserved), '/hrm/compliance?section=rates&kind=statutory')
})
