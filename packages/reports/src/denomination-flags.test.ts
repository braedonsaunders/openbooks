import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { REPORT_ENTITIES, REPORT_ENTITY_MAP } from './entities'
import { formatMeasureValue } from './run'

// E31: denomination flags must be enforceable, not decorative. A txnCurrency
// flag without a currencyColumn (or baseMoney without a baseCurrencyColumn)
// cannot pin or partition, so the run-time census fail-opens and the flag is
// a prose claim without a mechanism. Conversely, a money column on a
// currency-dimensioned entity with NEITHER flag blends denominations
// silently. Money on dimension-less entities (no currency column in schema —
// e.g. items/fixed_assets store bare numerics) is single-denomination by
// construction; those columns are named below so the exclusion is explicit,
// per-lane, and must be edited deliberately — never silent.
describe('denomination flags are enforceable', () => {
  it('every money column on a currency-dimensioned entity carries a denomination flag', () => {
    const violations: string[] = []
    for (const entity of REPORT_ENTITIES) {
      if (!entity.currencyColumn && !entity.baseCurrencyColumn) continue
      for (const column of entity.columns ?? []) {
        if (column.kind !== 'money') continue
        if (column.txnCurrency !== true && column.baseMoney !== true) {
          violations.push(`${String(entity.key)}.${String(column.key)}`)
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `money without a denomination flag blends silently — flag it or move it to the named exclusion: ${violations.join(', ')}`,
    )
  })

  it('no denomination flag without its observation dimension', () => {
    const violations: string[] = []
    for (const entity of REPORT_ENTITIES) {
      for (const column of entity.columns ?? []) {
        if (column.kind !== 'money') continue
        if (column.txnCurrency === true && !entity.currencyColumn) {
          violations.push(`${String(entity.key)}.${String(column.key)} claims txnCurrency with no currencyColumn`)
        }
        if (column.baseMoney === true && !entity.baseCurrencyColumn) {
          violations.push(`${String(entity.key)}.${String(column.key)} claims baseMoney with no baseCurrencyColumn`)
        }
      }
    }
    assert.deepEqual(violations, [], `vacuous denomination flags: ${violations.join('; ')}`)
  })

  // Dimension-less by schema (verified: no currency column on the underlying
  // tables), single-denomination by construction. Each entry names the owning
  // lane that must resolve it if a currency dimension ever appears.
  const DIMENSIONLESS_UNFLAGGED: Record<string, readonly string[]> = {
    // reports/inventory lane
    items: ['default_rate', 'default_cost'],
    inventory_lot_movements: ['unit_cost', 'total_value'],
    fixed_assets: [
      'acquisition_cost',
      'remaining_cost',
      'carrying_value',
      'accumulated_depreciation',
      'salvage_value',
    ],
    // assets/field lane
    equipment: ['purchase_price', 'cost_recovery', 'billable_value', 'billed_revenue', 'depreciation'],
    // payroll lane
    pay_stubs: [
      'gross',
      'cpp_fica',
      'ei',
      'income_tax',
      'net_pay',
      'employer_cost',
      'vacation_accrued',
      'pensionable',
      'insurable',
    ],
    pay_stub_lines: ['amount', 'ytd_amount'],
    payroll_parallel_findings: ['prior_amount', 'our_amount', 'difference', 'tolerance_applied'],
    // entitlements/allocations lanes
    entitlement_balances: ['balance', 'max_balance', 'notify_balance', 'headroom', 'owed_to_employer'],
    allocation_runs: ['source_total', 'allocated_total', 'residual'],
    allocation_lineage: ['amount', 'residual'],
    // crm lane
    crm_account_profiles: ['annual_revenue'],
  }

  it('dimension-less unflagged money is named exactly — no silent additions', () => {
    const observed: Record<string, string[]> = {}
    for (const entity of REPORT_ENTITIES) {
      const unflagged = (entity.columns ?? [])
        .filter((c) => c.kind === 'money' && c.txnCurrency !== true && c.baseMoney !== true)
        .map((c) => String(c.key))
      if (unflagged.length > 0) observed[String(entity.key)] = unflagged
    }
    assert.deepEqual(
      observed,
      DIMENSIONLESS_UNFLAGGED,
      'unflagged money changed: flag the new column, or name its lane in DIMENSIONLESS_UNFLAGGED',
    )
  })

  it('documents/transaction_lines base coverage is the named sibling ledger_lines', () => {
    for (const key of ['documents', 'transaction_lines'] as const) {
      const entity = REPORT_ENTITY_MAP[key]
      assert.ok(entity, `${key} entity must exist`)
      assert.ok(!entity.baseCurrencyColumn, `${key} has no base dimension, so it cannot carry baseMoney twins`)
      const money = (entity.columns ?? []).filter((c) => c.kind === 'money')
      assert.ok(money.length > 0, `${key} must expose money columns`)
      for (const column of money) {
        assert.equal(
          column.txnCurrency,
          true,
          `${key}.${String(column.key)} must be txnCurrency-flagged; base coverage lives in ledger_lines`,
        )
      }
    }
    const ledger = REPORT_ENTITY_MAP.ledger_lines
    assert.ok(ledger, 'ledger_lines entity must exist')
    const baseTwins = (ledger.columns ?? []).filter((c) => c.kind === 'money' && c.baseMoney === true)
    assert.ok(
      baseTwins.length > 0,
      'ledger_lines must carry the baseMoney twins covering documents/transaction_lines',
    )
  })

  it('dimension-less money renders raw — no 0dp truncation on items default_rate avg', () => {
    const items = REPORT_ENTITY_MAP.items
    assert.ok(items, 'items entity must exist')
    assert.equal(
      formatMeasureValue(items, { fn: 'avg', column: 'default_rate', label: 'Avg rate' }, '12.34'),
      '12.34',
    )
  })

  it('fixed_assets carrying_value is in the named exclusion (E31 scope probe)', () => {
    const assets = REPORT_ENTITY_MAP.fixed_assets
    assert.ok(assets, 'fixed_assets entity must exist')
    const carrying = (assets.columns ?? []).find((c) => c.key === 'carrying_value')
    assert.ok(carrying, 'fixed_assets.carrying_value must exist')
    assert.equal(carrying.kind, 'money')
    assert.ok(
      DIMENSIONLESS_UNFLAGGED.fixed_assets!.includes('carrying_value'),
      'fixed_assets.carrying_value must stay in the named dimension-less exclusion until a currency dimension exists',
    )
  })
})
