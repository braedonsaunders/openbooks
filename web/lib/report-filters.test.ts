import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBuiltInUrlFilters,
  BUILT_IN_REPORT_DEFINITION_MAP,
  type ReportRule,
  type ReportRuleGroup,
} from '@openbooks/reports'
import { buildDrillTarget, isReportUuidParam, parseReportQuery, toSearchParams } from './report-filters'
import { encodeReportDrillTarget, parseReportDrillTarget } from './report-drill'

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

test('profit-subtotal drills are profit-signed so the dialog net ties to the P&L cell (F-t07-001)', () => {
  // Net income mixes credit-normal revenue with debit-normal costs. A
  // reader-signed net sums them (Debits + Credits); the P&L cell is
  // Revenue − Costs, so the drill must carry profitSigned for its net to tie.
  const column = { kind: 'amount' as const, from: '2026-01-01', to: '2026-12-31' }
  const base = { column, mode: 'flow' as const, reportDims: {}, basis: 'accrual' as const, label: 'Net income · FY 2026' }
  const pnlTypes = ['income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred']
  const net = buildDrillTarget({ ...base, drillTypes: pnlTypes })
  assert.equal(net?.kind, 'ledger')
  assert.equal(net?.kind === 'ledger' && net.profitSigned, true)
  // The flag must survive the URL round-trip or the drawer still sums.
  const roundTripped = parseReportDrillTarget(encodeReportDrillTarget(net!))
  assert.equal(roundTripped?.kind === 'ledger' && roundTripped.profitSigned, true)

  const gross = buildDrillTarget({ ...base, drillTypes: ['income', 'income_other', 'cogs'] })
  assert.equal(gross?.kind === 'ledger' && gross.profitSigned, true)

  // Single-section totals keep reader-signed nets (revenue/COGS/expenses as shown).
  for (const types of [['income', 'income_other'], ['cogs'], ['expense', 'expense_other', 'expense_deferred']]) {
    const section = buildDrillTarget({ ...base, drillTypes: types })
    assert.equal(section?.kind === 'ledger' && section.profitSigned, undefined)
  }

  // Balance-sheet rows: asset-only stays reader-signed; accumulated earnings
  // (pure P&L, balance mode) is a profit row too.
  const assets = buildDrillTarget({ ...base, mode: 'balance', drillTypes: ['asset_bank', 'asset_receivable'] })
  assert.equal(assets?.kind === 'ledger' && assets.profitSigned, undefined)
  const accumulated = buildDrillTarget({ ...base, mode: 'balance', drillTypes: pnlTypes })
  assert.equal(accumulated?.kind === 'ledger' && accumulated.profitSigned, true)
})

test('dimension filter params must be uuids — malformed values are dropped, never bound', () => {
  // RP7: dept/project/location/class bound raw into uuid predicates and every
  // statement page/export answered a hand-edited ?dept=abc with a database
  // cast error. They now get the same re-clamp as `customer`.
  const malformed = parseReportQuery(new URLSearchParams({
    dept: 'abc',
    project: "' or true --",
    location: '00000000-0000-0000-0000',
    class: CUSTOMER_ID.slice(1),
  }))
  assert.deepEqual(malformed.dims, { departmentId: undefined, projectId: undefined, locationId: undefined, classId: undefined, segments: {} })
  const valid = parseReportQuery({ dept: CUSTOMER_ID, project: CUSTOMER_ID, location: CUSTOMER_ID, class: CUSTOMER_ID })
  assert.deepEqual(valid.dims, { departmentId: CUSTOMER_ID, projectId: CUSTOMER_ID, locationId: CUSTOMER_ID, classId: CUSTOMER_ID, segments: {} })
  assert.equal(toSearchParams(valid).get('dept'), CUSTOMER_ID)
  assert.equal(isReportUuidParam(CUSTOMER_ID), true)
  assert.equal(isReportUuidParam('abc'), false)
  assert.equal(isReportUuidParam(null), false)
  assert.equal(isReportUuidParam(undefined), false)
})
