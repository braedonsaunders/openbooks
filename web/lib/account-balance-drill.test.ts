import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACCOUNT_CLASS_TYPES,
  ASSET_TYPES,
  EQUITY_TYPES,
  LIABILITY_TYPES,
  PNL_COST_TYPES,
  PNL_TYPES,
} from './account-types'
import {
  accountBalanceDrill,
  accountClassBalanceDrill,
  accountListBalanceDrill,
} from './account-balance-drill'
import { encodeReportDrillTarget, parseReportDrillTarget } from './report-drill'

const ACCOUNT_ID = '018f47aa-7c11-7a12-8bc3-1234567890ab'
const WINDOW = { from: '2026-09-01', to: '2026-09-30', period: 'this_period' }

test('CoA class types partition the P&L and reuse the statement asset lists', () => {
  assert.deepEqual([...ACCOUNT_CLASS_TYPES.expense], PNL_COST_TYPES)
  assert.deepEqual(
    [...ACCOUNT_CLASS_TYPES.income, ...ACCOUNT_CLASS_TYPES.expense].sort(),
    [...PNL_TYPES].sort(),
  )
  assert.deepEqual([...ACCOUNT_CLASS_TYPES.asset], ASSET_TYPES)
  assert.deepEqual([...ACCOUNT_CLASS_TYPES.liability], LIABILITY_TYPES)
  assert.deepEqual([...ACCOUNT_CLASS_TYPES.equity], EQUITY_TYPES)
})

test('CoA balances drill the current period as newest-first flow, P&L and balance-sheet alike', () => {
  const income = accountBalanceDrill({
    accountId: ACCOUNT_ID,
    label: '4000 Sales',
    type: 'income',
    ...WINDOW,
  })
  const bank = accountBalanceDrill({
    accountId: ACCOUNT_ID,
    label: '1000 Cash',
    type: 'asset_bank',
    ...WINDOW,
  })
  const expected = {
    kind: 'ledger',
    accountIds: [ACCOUNT_ID],
    mode: 'flow',
    from: WINDOW.from,
    to: WINDOW.to,
    period: 'this_period',
    newestFirst: true,
  }
  assert.deepEqual(income, { ...expected, label: '4000 Sales' })
  assert.deepEqual(bank, { ...expected, label: '1000 Cash' })
  const parsedIncome = parseReportDrillTarget(encodeReportDrillTarget(income!))
  const parsedBank = parseReportDrillTarget(encodeReportDrillTarget(bank!))
  assert.equal(parsedIncome?.kind, 'ledger')
  assert.equal(parsedBank?.kind, 'ledger')
  if (parsedIncome?.kind !== 'ledger' || parsedBank?.kind !== 'ledger') assert.fail('expected ledger targets')
  assert.equal(parsedIncome.mode, 'flow')
  assert.equal(parsedIncome.from, WINDOW.from)
  assert.equal(parsedIncome.period, 'this_period')
  assert.equal(parsedIncome.newestFirst, true)
  assert.deepEqual(parsedIncome.accountIds, [ACCOUNT_ID])
  assert.equal(parsedBank.mode, 'flow')
  assert.equal(parsedBank.newestFirst, true)
  assert.deepEqual(parsedBank.accountIds, [ACCOUNT_ID])
})

test('class-total drills name every type in the class and refuse an unknown class', () => {
  const income = accountClassBalanceDrill({ classKey: 'income', label: 'Income', ...WINDOW })
  const assets = accountClassBalanceDrill({ classKey: 'asset', label: 'Assets', ...WINDOW })
  assert.deepEqual(income.accountTypes, [...ACCOUNT_CLASS_TYPES.income])
  assert.equal(income.mode, 'flow')
  assert.equal(income.from, WINDOW.from)
  assert.equal(income.period, 'this_period')
  assert.equal(income.newestFirst, true)
  assert.deepEqual(assets.accountTypes, [...ASSET_TYPES])
  assert.equal(assets.mode, 'flow')
  const roundTripped = parseReportDrillTarget(encodeReportDrillTarget(income))
  assert.equal(roundTripped?.kind, 'ledger')
  assert.equal(roundTripped?.kind === 'ledger' ? roundTripped.mode : null, 'flow')
  assert.throws(
    () => accountClassBalanceDrill({ classKey: 'other', label: 'Other', ...WINDOW }),
    /ACCOUNT_CLASS_TYPES/,
  )
})

test('list balance drill uses the always-selected type and refuses a hidden or invalid row', () => {
  const ok = accountListBalanceDrill(
    {
      id: ACCOUNT_ID,
      drill_account_type: 'expense',
      drill_account_number: '6100',
      drill_account_name: 'Rent',
      type: 'asset_bank',
    },
    'balance',
    WINDOW,
  )
  assert.equal(ok?.mode, 'flow')
  assert.equal(ok?.period, 'this_period')
  assert.equal(ok?.newestFirst, true)
  assert.equal(ok?.label, '6100 Rent')
  assert.equal(accountListBalanceDrill({ id: ACCOUNT_ID, type: 'expense' }, 'name', WINDOW), null)
  assert.equal(
    accountListBalanceDrill({ id: 'not-a-uuid', drill_account_type: 'expense', drill_account_name: 'Rent' }, 'balance', WINDOW),
    null,
  )
  assert.equal(accountListBalanceDrill({ id: ACCOUNT_ID, drill_account_name: 'Rent' }, 'balance', WINDOW), null)
})
