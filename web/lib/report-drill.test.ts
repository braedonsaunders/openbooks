import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { encodeReportDrillTarget, parseReportDrillTarget, type ReportDrillTarget } from './report-drill'

const reportDrillData = readFileSync(new URL('./report-drill-data.ts', import.meta.url), 'utf8')

const ACCOUNT_ID = '018f47aa-7c11-7a12-8bc3-1234567890ab'
const PARTY_ID = '018f47aa-7c11-7a12-8bc3-1234567890ac'
const CUSTOMER_ID = '018f47aa-7c11-7a12-8bc3-1234567890ad'

test('report drill targets round-trip through URL state', () => {
  const target: ReportDrillTarget = {
    kind: 'ledger',
    label: 'Gross profit',
    accountIds: [ACCOUNT_ID],
    from: '2026-01-01',
    to: '2026-12-31',
    mode: 'flow',
    basis: 'accrual',
    partyIds: [PARTY_ID],
    projectCustomerId: CUSTOMER_ID,
    projectSearch: 'dryer repair',
    activeProjectsOnly: true,
    profitSigned: true,
    dims: { projectId: ACCOUNT_ID, segments: { region: PARTY_ID } },
  }
  const parsed = parseReportDrillTarget(encodeReportDrillTarget(target))
  assert.equal(parsed?.kind, 'ledger')
  if (parsed?.kind !== 'ledger') assert.fail('expected ledger target')
  assert.equal(parsed.label, target.label)
  assert.deepEqual(parsed.accountIds, [ACCOUNT_ID])
  assert.deepEqual(parsed.partyIds, [PARTY_ID])
  assert.equal(parsed.projectCustomerId, CUSTOMER_ID)
  assert.equal(parsed.projectSearch, 'dryer repair')
  assert.equal(parsed.activeProjectsOnly, true)
  assert.equal(parsed.profitSigned, true)
  assert.equal(parsed.dims?.projectId, ACCOUNT_ID)
  assert.deepEqual(parsed.dims?.segments, { region: PARTY_ID })
})

test('report drill parsing fails closed for malformed or overbroad URL input', () => {
  assert.equal(parseReportDrillTarget(null), null)
  assert.equal(parseReportDrillTarget('{'), null)
  assert.equal(parseReportDrillTarget('x'.repeat(8_001)), null)
  assert.equal(parseReportDrillTarget(JSON.stringify({ kind: 'ledger', label: 'x', to: 'not-a-date', mode: 'flow' })), null)
  assert.equal(parseReportDrillTarget(JSON.stringify({ kind: 'ledger', label: 'x', to: '2026-12-31', mode: 'flow', accountIds: ['not-a-uuid'] })), null)
  assert.equal(parseReportDrillTarget(JSON.stringify({ kind: 'ledger', label: 'x', to: '2026-12-31', mode: 'flow', projectCustomerId: 'not-a-uuid' })), null)
  assert.equal(parseReportDrillTarget(JSON.stringify({ kind: 'ledger', label: 'x', to: '2026-12-31', mode: 'flow', projectSearch: '' })), null)
  assert.equal(parseReportDrillTarget(JSON.stringify({ kind: 'time', label: 'x', from: '2026-01-01', to: '2026-12-31', projectCustomerId: CUSTOMER_ID, unassignedProjectCustomer: true })), null)
  assert.equal(parseReportDrillTarget(JSON.stringify({ kind: 'custom', label: 'x', source: 'definition', id: "' or true --" })), null)
})

test('report drill parsing clamps enum values instead of accepting arbitrary query modes', () => {
  const target = parseReportDrillTarget(JSON.stringify({ kind: 'orders', label: 'Open', orderKind: 'invoice', scope: 'open' }))
  assert.equal(target, null)
})

test('order drill routes conversion, backlog, and voided scopes through the right predicates', () => {
  assert.match(
    reportDrillData,
    /const linkedOrderPredicate = sql`[\s\S]*?document_links link[\s\S]*?link\.from_document_id = d\.id[\s\S]*?link\.org_id = d\.org_id[\s\S]*?`/,
    'converted orders must use the shared tenant-pinned document-link predicate',
  )
  assert.match(
    reportDrillData,
    /const openOrderPredicate = sql`[\s\S]*?d\.status <> 'voided'[\s\S]*?line\.quantity_billed < line\.quantity[\s\S]*?`/,
    'open/backlog orders must still require unconverted line quantity',
  )
  assert.match(
    reportDrillData,
    /const predicate = scope === 'voided'\s+\? sql`d\.status = 'voided'`\s+: scope === 'converted'\s+\? linkedOrderPredicate\s+: scope === 'conversion'\s+\? linkedOrderPredicate\s+: openOrderPredicate/,
    'conversion-rate drills must include linked orders only without changing open or voided scopes',
  )
})
