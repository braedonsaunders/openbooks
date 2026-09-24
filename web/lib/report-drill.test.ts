import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyLedgerDrillWindow,
  encodeReportDrillTarget,
  parseReportDrillTarget,
  type ReportDrillTarget,
} from './report-drill'

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
    bookId: ACCOUNT_ID,
    projectSearch: 'dryer repair',
    activeProjectsOnly: true,
    profitSigned: true,
    dims: { projectId: ACCOUNT_ID, segments: { region: PARTY_ID } },
    period: 'this_period',
    newestFirst: true,
  }
  const parsed = parseReportDrillTarget(encodeReportDrillTarget(target))
  assert.equal(parsed?.kind, 'ledger')
  if (parsed?.kind !== 'ledger') assert.fail('expected ledger target')
  assert.equal(parsed.label, target.label)
  assert.deepEqual(parsed.accountIds, [ACCOUNT_ID])
  assert.deepEqual(parsed.partyIds, [PARTY_ID])
  assert.equal(parsed.projectCustomerId, CUSTOMER_ID)
  assert.equal(parsed.bookId, ACCOUNT_ID)
  assert.equal(parsed.projectSearch, 'dryer repair')
  assert.equal(parsed.activeProjectsOnly, true)
  assert.equal(parsed.profitSigned, true)
  assert.equal(parsed.dims?.projectId, ACCOUNT_ID)
  assert.deepEqual(parsed.dims?.segments, { region: PARTY_ID })
  assert.equal(parsed.period, 'this_period')
  assert.equal(parsed.newestFirst, true)
})

test('applyLedgerDrillWindow overwrites the flow window and keeps account scope', () => {
  const next = applyLedgerDrillWindow(
    {
      kind: 'ledger',
      label: '1000 Cash',
      accountIds: [ACCOUNT_ID],
      mode: 'balance',
      to: '2026-12-31',
      newestFirst: true,
      period: 'this_period',
    },
    { from: '2026-08-01', to: '2026-08-31', period: 'last_period' },
  )
  assert.equal(next.mode, 'flow')
  assert.equal(next.from, '2026-08-01')
  assert.equal(next.to, '2026-08-31')
  assert.equal(next.period, 'last_period')
  assert.deepEqual(next.accountIds, [ACCOUNT_ID])
  assert.equal(next.newestFirst, true)
})

test('an unknown period preset is dropped so the encoded from/to still open', () => {
  const parsed = parseReportDrillTarget(JSON.stringify({
    kind: 'ledger',
    label: '1000 Cash',
    to: '2026-09-30',
    from: '2026-09-01',
    mode: 'flow',
    period: 'not_a_preset',
    newestFirst: true,
  }))
  assert.equal(parsed?.kind, 'ledger')
  if (parsed?.kind !== 'ledger') assert.fail('expected ledger target')
  assert.equal(parsed.period, undefined)
  assert.equal(parsed.from, '2026-09-01')
  assert.equal(parsed.newestFirst, true)
})

test('report drill parsing fails closed for malformed or overbroad URL input', () => {
  for (const bookId of ['', 'invalid', null, 1]) {
    assert.equal(parseReportDrillTarget(JSON.stringify({ kind: 'ledger', label: 'x', to: '2026-12-31', bookId })), null)
  }
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

test('aging drill targets round-trip their currency selection', () => {
  const target: ReportDrillTarget = {
    kind: 'aging',
    label: 'Acme · 1–30',
    side: 'ar',
    asOf: '2026-07-31',
    currencyBasis: 'transaction',
    currency: 'EUR',
  }
  const parsed = parseReportDrillTarget(encodeReportDrillTarget(target))
  assert.equal(parsed?.kind, 'aging')
  if (parsed?.kind !== 'aging') assert.fail('expected aging target')
  assert.equal(parsed.currencyBasis, 'transaction')
  assert.equal(parsed.currency, 'EUR')
})

test('aging drill parsing clamps currency fields instead of trusting the URL', () => {
  const bad = parseReportDrillTarget(JSON.stringify({
    kind: 'aging', label: 'x', side: 'ar', asOf: '2026-07-31',
    currencyBasis: 'cash', currency: 'eur',
  }))
  assert.equal(bad?.kind, 'aging')
  if (bad?.kind !== 'aging') assert.fail('expected aging target')
  assert.equal(bad.currencyBasis, undefined)
  assert.equal(bad.currency, undefined)
  const injection = parseReportDrillTarget(JSON.stringify({
    kind: 'aging', label: 'x', side: 'ar', asOf: '2026-07-31',
    currency: "EUR' or true --",
  }))
  assert.equal(injection?.kind, 'aging')
  if (injection?.kind !== 'aging') assert.fail('expected aging target')
  assert.equal(injection.currency, undefined)
})
