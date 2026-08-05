import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReportQuery, toSearchParams } from './report-filters'

const CUSTOMER_ID = '018f47aa-7c11-7a12-8bc3-1234567890ad'

test('project profitability customer scope round-trips through shared report params', () => {
  const query = parseReportQuery(new URLSearchParams({
    period: 'custom',
    from: '2026-01-01',
    to: '2026-03-31',
    customer: CUSTOMER_ID,
  }))
  assert.equal(query.customerId, CUSTOMER_ID)
  assert.equal(toSearchParams(query).get('customer'), CUSTOMER_ID)
  assert.equal(toSearchParams(query).get('from'), '2026-01-01')
  assert.equal(toSearchParams(query).get('to'), '2026-03-31')
})

test('project profitability customer scope rejects malformed ids', () => {
  assert.equal(parseReportQuery(new URLSearchParams({ customer: "' or true --" })).customerId, undefined)
})

test('project profitability defaults to active projects and round-trips all projects explicitly', () => {
  assert.equal(parseReportQuery(new URLSearchParams()).projectScope, 'active')
  assert.equal(toSearchParams(parseReportQuery(new URLSearchParams())).has('projects'), false)

  const all = parseReportQuery(new URLSearchParams({ projects: 'all' }))
  assert.equal(all.projectScope, 'all')
  assert.equal(toSearchParams(all).get('projects'), 'all')
})

test('project profitability rejects an unknown project population', () => {
  assert.equal(parseReportQuery(new URLSearchParams({ projects: 'closed' })).projectScope, 'active')
})
