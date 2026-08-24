import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBuiltInUrlFilters,
  BUILT_IN_REPORT_DEFINITION_MAP,
  type ReportRule,
  type ReportRuleGroup,
} from '@openbooks/reports'
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

test('lot recall saved-view params resolve to the same filters while viewer/export params stay inert', () => {
  const definition = BUILT_IN_REPORT_DEFINITION_MAP['lot-recall']!
  const query = applyBuiltInUrlFilters(definition, new URLSearchParams({
    lotNumber: 'ABC',
    itemId: CUSTOMER_ID,
    expiresOnOrBefore: '2027-01-31',
    expiring: '1',
    page: '9',
    perPage: '100',
    format: 'xlsx',
  }))
  const leaves: ReportRule[] = []
  const walk = (group: ReportRuleGroup | null | undefined): void => {
    for (const rule of group?.rules ?? []) {
      if (Array.isArray((rule as ReportRuleGroup).rules)) walk(rule as ReportRuleGroup)
      else leaves.push(rule as ReportRule)
    }
  }
  walk(query.filters)
  assert.deepEqual(leaves, [
    { field: 'lot_number', op: 'contains', value: 'ABC' },
    { field: 'item_id', op: 'eq', value: CUSTOMER_ID },
    { field: 'expires_on', op: 'lte', value: '2027-01-31' },
    { field: 'expires_on', op: 'is_not_null' },
  ])
})
