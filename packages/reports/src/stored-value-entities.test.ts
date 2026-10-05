import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
import { compileCustomQuery } from './custom-query'
import { REPORT_ENTITIES, REPORT_ENTITY_MAP } from './entities'
import { validateCustomQuery } from './validate'

const ORG = '00000000-0000-4000-8000-000000000001'

// Stored value (gift cards and store credit) is a liability subledger, so its
// reports read the immutable entries and the open accounts — never the GL,
// which sees only the posted control totals. The roll-forward groups entry
// movements by program and month; unclaimed property groups open balances by
// the customer's region with last-activity months as the dormancy cohorts.
describe('stored-value report entities', () => {
  it('declares the movements ledger and the open-balances snapshot', () => {
    for (const key of ['stored_value_movements', 'stored_value_balances'] as const) {
      const entity = REPORT_ENTITY_MAP[key]
      assert.ok(entity, `${key} is in the report catalog`)
      assert.equal(entity.featureKey, 'storedValue')
      assert.equal(entity.requiredPermission, 'stored_value.read')
      assert.equal(entity.orgColumn, key === 'stored_value_movements' ? 'e.org_id' : 'a.org_id')
      for (const join of entity.from.split('\n').filter((line) => /\bJOIN\b/i.test(line))) {
        assert.match(join, /org_id/i, `${key} join leaves the organization: ${join.trim()}`)
      }
    }
    const movements = REPORT_ENTITY_MAP.stored_value_movements!
    assert.equal(movements.timeKey, 'entered_on')
    assert.ok(movements.latestOrderExpr, 'balance_after latest needs a chronological order')
    for (const column of movements.columns.filter((c) => c.kind === 'money')) {
      assert.equal(column.txnCurrency, true, `${column.key} blends currencies without a flag`)
    }
    const balances = REPORT_ENTITY_MAP.stored_value_balances!
    assert.equal(balances.defaultPeriodField, null, 'a balance snapshot must not acquire a fiscal window')
  })

  it('compiles the liability roll-forward: per-kind sums plus closing by program and month', () => {
    const entity = REPORT_ENTITY_MAP.stored_value_movements!
    const query = validateCustomQuery({
      entity: entity.key,
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'program' }, { column: 'entered_on', bin: 'month' }, { column: 'currency' }],
      measures: [
        { fn: 'sum', column: 'amount', key: 'issued', label: 'Issued', filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'issue' }] } },
        { fn: 'sum', column: 'amount', key: 'redeemed', label: 'Redeemed', filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'redeem' }] } },
        { fn: 'sum', column: 'amount', key: 'breakage', label: 'Breakage', filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'breakage' }] } },
        { fn: 'sum', column: 'amount', key: 'expired', label: 'Expired', filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'expire' }] } },
        { fn: 'sum', column: 'amount', key: 'adjustments', label: 'Adjustments', filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'adjust' }] } },
        { fn: 'closing', column: 'balance_after', label: 'Closing liability' },
        { fn: 'count', label: 'Movements' },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    })
    const compiled = compileCustomQuery(entity, query, ORG)
    assert.match(compiled.text, /WHERE e\.org_id = \$1/)
    assert.match(compiled.text, /stored_value_entries/)
  })

  it('compiles unclaimed property: open balances by customer region and activity month', () => {
    const entity = REPORT_ENTITY_MAP.stored_value_balances!
    const query = validateCustomQuery({
      entity: entity.key,
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'customer_region' }, { column: 'last_activity_on', bin: 'month' }, { column: 'currency' }],
      measures: [
        { fn: 'sum', column: 'balance', label: 'Open balance' },
        { fn: 'count', label: 'Accounts' },
        { fn: 'min', column: 'last_activity_on', label: 'Oldest activity' },
      ],
      filters: {
        combinator: 'and',
        rules: [{ field: 'status', op: 'in', value: ['active', 'frozen'] }],
      },
      groupBy: null,
      limit: 1000,
    })
    const compiled = compileCustomQuery(entity, query, ORG)
    assert.match(compiled.text, /WHERE a\.org_id = \$1/)
    assert.match(compiled.text, /stored_value_accounts/)
  })

  it('ships both reports as built-ins that survive the seed-time sanitiser', () => {
    assert.ok(
      REPORT_ENTITIES.some((entity) => entity.key === 'stored_value_movements'),
      'movements entity is registered',
    )
    for (const slug of ['stored-value-liability-roll-forward', 'stored-value-unclaimed-property'] as const) {
      const def = BUILT_IN_REPORT_DEFINITION_MAP[slug]
      assert.ok(def, `${slug} is a built-in report`)
      validateCustomQuery(def.query)
    }
  })
})
