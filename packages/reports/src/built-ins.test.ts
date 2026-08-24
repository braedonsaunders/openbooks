import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  applyBuiltInUrlFilters,
  BUILT_IN_REPORT_DEFINITION_MAP,
  BUILT_IN_REPORT_DEFINITIONS,
} from './built-ins'
import { REPORT_ENTITY_MAP } from './entities'
import { compileRule, SqlParams } from './filters'
import { resolvePreset, PERIOD_PRESET_IDS } from './period-presets'
import { validateCustomQuery } from './validate'
import type { ReportRule } from './types'

// Built-in year-wide windows must follow the org's FISCAL calendar. The plans
// express that with the `period_preset` operator ('this_fiscal_year'), which
// the web executor resolves to concrete gte/lte bounds before compilation —
// never the calendar-only `this_year`, which mislabels itself "this FY" for
// any org whose fiscal year does not start in January.

function leafRules(def: (typeof BUILT_IN_REPORT_DEFINITIONS)[number]): ReportRule[] {
  const leaves: ReportRule[] = []
  const walk = (node: NonNullable<typeof def.query.filters>): void => {
    for (const r of node.rules) {
      if (Array.isArray((r as { rules?: unknown }).rules)) walk(r as typeof node)
      else leaves.push(r as ReportRule)
    }
  }
  if (def.query.filters) walk(def.query.filters)
  return leaves
}

describe('built-in report definitions', () => {
  it('window every year-wide plan on the fiscal-year preset, not the calendar year', () => {
    let windowed = 0
    for (const def of BUILT_IN_REPORT_DEFINITIONS) {
      for (const leaf of leafRules(def)) {
        assert.notEqual(leaf.op, 'this_year', `${def.slug} still filters on the calendar year`)
        if (leaf.op === 'period_preset') {
          windowed += 1
          assert.equal(leaf.value, 'this_fiscal_year', `${def.slug} uses an unexpected preset`)
          assert.ok(PERIOD_PRESET_IDS.includes(leaf.value), `${def.slug} preset id is not in the catalog`)
        }
      }
    }
    assert.ok(windowed > 0, 'expected at least one fiscal-year-windowed built-in')
  })

  it('survives the definition sanitiser used at seed and run time', () => {
    const def = BUILT_IN_REPORT_DEFINITIONS.find((d) => d.slug === 'gl-activity-by-account-fy')!
    const clean = validateCustomQuery(def.query)
    const leaves = leafRules({ ...def, query: clean })
    assert.ok(leaves.some((l) => l.op === 'period_preset' && l.value === 'this_fiscal_year'))
  })

  it('keeps every catalog plan valid for seeding and execution', () => {
    for (const def of BUILT_IN_REPORT_DEFINITIONS) {
      assert.doesNotThrow(
        () => validateCustomQuery(def.query),
        `${def.slug} does not survive the report-query validator`,
      )
    }
  })

  it('defines lot recall as a valid, stably sorted inventory query without an implicit period', () => {
    const def = BUILT_IN_REPORT_DEFINITION_MAP['lot-recall']
    assert.ok(def)
    const clean = validateCustomQuery(def.query)
    assert.equal(clean.entity, 'inventory_lot_movements')
    assert.equal(clean.filters, null)
    assert.deepEqual(clean.sorts, [
      { column: 'moved_at', direction: 'desc' },
      { column: 'movement_id', direction: 'desc' },
    ])
    assert.equal(REPORT_ENTITY_MAP[clean.entity]?.featureKey, 'inventory')
    assert.equal(REPORT_ENTITY_MAP[clean.entity]?.defaultPeriodField, null)
  })

  it('applies one authoritative lot-recall filter set without mutating the catalog query', () => {
    const def = BUILT_IN_REPORT_DEFINITION_MAP['lot-recall']!
    const itemId = '10000000-0000-4000-8000-000000000001'
    const filtered = applyBuiltInUrlFilters(def, new URLSearchParams({
      lotNumber: ' LOT-42 ',
      itemId,
      expiresOnOrBefore: '2027-02-28',
      expiring: '1',
    }))
    assert.equal(def.query.filters, null, 'the static built-in query must remain unchanged')
    assert.deepEqual(leafRules({ ...def, query: filtered }), [
      { field: 'lot_number', op: 'contains', value: 'LOT-42' },
      { field: 'item_id', op: 'eq', value: itemId },
      { field: 'expires_on', op: 'lte', value: '2027-02-28' },
      { field: 'expires_on', op: 'is_not_null' },
    ])
    assert.doesNotThrow(() => validateCustomQuery(filtered))
  })

  it('layers URL controls onto an organization-tuned built-in query', () => {
    const catalog = BUILT_IN_REPORT_DEFINITION_MAP['lot-recall']!
    const tunedQuery = validateCustomQuery({
      ...catalog.query,
      columns: ['lot_number', 'item_name', 'quantity'],
      filters: {
        combinator: 'and',
        rules: [{ field: 'status', op: 'eq', value: 'posted' }],
      },
    })
    const effective = applyBuiltInUrlFilters(
      { ...catalog, query: tunedQuery },
      { lotNumber: 'TUNED' },
    )
    assert.deepEqual(effective.columns, ['lot_number', 'item_name', 'quantity'])
    assert.deepEqual(leafRules({ ...catalog, query: effective }), [
      { field: 'status', op: 'eq', value: 'posted' },
      { field: 'lot_number', op: 'contains', value: 'TUNED' },
    ])
    assert.deepEqual(tunedQuery.filters, {
      combinator: 'and',
      rules: [{ field: 'status', op: 'eq', value: 'posted' }],
    })
  })

  it('fails closed on malformed lot-recall UUID and date parameters', () => {
    const def = BUILT_IN_REPORT_DEFINITION_MAP['lot-recall']!
    assert.throws(
      () => applyBuiltInUrlFilters(def, { itemId: 'not-a-uuid' }),
      /Invalid report parameter: itemId/,
    )
    assert.throws(
      () => applyBuiltInUrlFilters(def, { expiresOnOrBefore: '2027-02-30' }),
      /Invalid report parameter: expiresOnOrBefore/,
    )
    assert.equal(
      applyBuiltInUrlFilters(def, { expiring: '0' }),
      def.query,
      'a non-activating flag must not silently add a filter',
    )
  })
})

describe('period_preset compile contract', () => {
  const entity = REPORT_ENTITY_MAP['ledger_lines']!

  it('leaves an unresolved preset as a documented no-op clause', () => {
    // Resolution happens web-side; the DB-free compiler must not invent a
    // window of its own (it drops the clause rather than guessing).
    const sql = compileRule(entity, { column: 'posting_date', op: 'period_preset' }, new SqlParams())
    assert.equal(sql, null)
  })

  it('resolves this_fiscal_year to July-start bounds, not the calendar year', () => {
    // The web executor (web/lib/custom-reports.ts) resolves the preset via
    // resolvePeriod → resolvePreset with the org's fiscalYearStartMonth. Pin
    // the exact window for a July-start org so a revert to calendar-year
    // semantics (the old `this_year`) fails loudly here.
    assert.deepEqual(
      resolvePreset('this_fiscal_year', { startMonth: 7, today: '2026-08-21' }),
      { from: '2026-07-01', to: '2027-06-30', label: 'FY 2027' },
    )
    // Same instant on a January-start org stays the plain calendar year.
    assert.deepEqual(
      resolvePreset('this_fiscal_year', { startMonth: 1, today: '2026-08-21' }),
      { from: '2026-01-01', to: '2026-12-31', label: 'FY 2026' },
    )
  })

  it('keeps the calendar this_year operator compiling for studio-authored plans', () => {
    const params = new SqlParams()
    const sql = compileRule(entity, { column: 'posting_date', op: 'this_year' }, params)
    assert.ok(sql?.includes("date_trunc('year'"))
    assert.equal(params.values.length, 0)
  })
})
