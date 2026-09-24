import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  applyBuiltInUrlFilters,
  BUILT_IN_REPORT_DEFINITION_MAP,
  BUILT_IN_REPORT_DEFINITIONS,
} from './built-ins'
import { REPORT_ENTITY_MAP } from './entities'
import { HRM_REPORT_ENTITIES } from './hrm-entities'
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

  it('materialises every governed HRM source in the one built-in catalog', () => {
    const hrmEntityKeys = new Set(HRM_REPORT_ENTITIES.map((entity) => entity.key))
    const catalogEntityKeys = new Set(
      BUILT_IN_REPORT_DEFINITIONS
        .map((definition) => definition.query.entity)
        .filter((entity) => hrmEntityKeys.has(entity)),
    )
    assert.deepEqual(catalogEntityKeys, hrmEntityKeys)
    assert.equal(
      BUILT_IN_REPORT_DEFINITIONS.filter((definition) => definition.slug.startsWith('workforce-')).length,
      HRM_REPORT_ENTITIES.length - 1,
      'headcount uses its curated statement; every other HRM source gets one workforce built-in',
    )
  })

  it('defines allocation summary and lineage as valid allocations-gated built-ins', () => {
    const summary = BUILT_IN_REPORT_DEFINITION_MAP['allocation-summary']
    assert.ok(summary)
    assert.equal(summary.query.entity, 'allocation_runs')
    assert.doesNotThrow(() => validateCustomQuery(summary.query))
    assert.equal(REPORT_ENTITY_MAP[summary.query.entity]?.requiredPermission, 'allocations.read')
    assert.equal(REPORT_ENTITY_MAP[summary.query.entity]?.featureKey, 'allocations')
    const breakouts = (summary.query.breakouts ?? []).map((b) => b.column)
    for (const column of ['rule_name', 'period', 'status']) {
      assert.ok(breakouts.includes(column), `summary breaks out by ${column}`)
    }
    const measures = (summary.query.measures ?? []).map((m) => `${m.fn}:${m.column}`)
    for (const measure of ['sum:source_total', 'sum:allocated_total', 'sum:residual', 'count:']) {
      assert.ok(
        measures.some((m) => m.startsWith(measure)),
        `summary measures ${measure}*`,
      )
    }

    const lineage = BUILT_IN_REPORT_DEFINITION_MAP['allocation-lineage']
    assert.ok(lineage)
    assert.equal(lineage.query.entity, 'allocation_lineage')
    assert.equal(lineage.query.mode, 'rows')
    assert.doesNotThrow(() => validateCustomQuery(lineage.query))
    assert.equal(REPORT_ENTITY_MAP[lineage.query.entity]?.requiredPermission, 'allocations.read')
    assert.equal(REPORT_ENTITY_MAP[lineage.query.entity]?.featureKey, 'allocations')
  })

  it('defines 4 standard CRM built-in reports with CRM feature gate and permissions', () => {
    const crmSlugs = [
      'crm-pipeline-summary',
      'crm-forecast-by-owner',
      'crm-win-loss-analysis',
      'crm-lead-conversion-funnel',
    ] as const

    for (const slug of crmSlugs) {
      const def = BUILT_IN_REPORT_DEFINITION_MAP[slug]
      assert.ok(def, `built-in report ${slug} must be defined`)
      assert.doesNotThrow(() => validateCustomQuery(def.query), `${slug} query must be valid`)
      const entity = REPORT_ENTITY_MAP[def.query.entity]
      assert.ok(entity, `entity ${def.query.entity} must exist`)
      assert.equal(entity.featureKey, 'crm')
    }

    const pipeline = BUILT_IN_REPORT_DEFINITION_MAP['crm-pipeline-summary']!
    assert.equal(pipeline.query.mode, 'summarize')
    assert.ok(pipeline.query.breakouts?.some((b) => b.column === 'currency'))

    const forecast = BUILT_IN_REPORT_DEFINITION_MAP['crm-forecast-by-owner']!
    assert.equal(forecast.query.mode, 'summarize')
    assert.ok(forecast.query.breakouts?.some((b) => b.column === 'currency'))

    const winLoss = BUILT_IN_REPORT_DEFINITION_MAP['crm-win-loss-analysis']!
    assert.equal(winLoss.query.mode, 'summarize')
    assert.ok(winLoss.query.breakouts?.some((b) => b.column === 'is_won'))

    const funnel = BUILT_IN_REPORT_DEFINITION_MAP['crm-lead-conversion-funnel']!
    assert.equal(funnel.query.entity, 'crm_account_profiles')
    assert.equal(funnel.query.mode, 'summarize')
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
    // Resolution happens web-side; the DB-free leaf compiler must not invent
    // a window of its own (it returns null rather than guessing). Null is a
    // leaf-level signal only: the group compiler throws on it instead of
    // dropping the date bounds and running unfiltered.
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

describe('open-aging built-ins count truly open lines', () => {
  // F-t07-007: is_open_item marks AR/AP-tracked lines, not unpaid ones, so
  // "Open AR by customer" counted paid invoices and their payment lines as
  // open (28 vs the aging detail's 16) and min()ed over stale due dates.
  // Both open-aging built-ins must filter on the application-aware
  // has_open_balance flag instead.
  for (const slug of ['open-ar-by-customer', 'ap-aging-by-vendor']) {
    it(`${slug} filters on application-aware openness, not the tracked-line flag`, () => {
      const def = BUILT_IN_REPORT_DEFINITION_MAP[slug]
      assert.ok(def, `${slug} must exist`)
      const leaves = leafRules(def)
      assert.ok(
        leaves.some((leaf) => leaf.field === 'has_open_balance' && leaf.op === 'is_true'),
        `${slug} must filter has_open_balance is_true so paid lines and consumed payments are excluded`,
      )
      assert.ok(
        leaves.every((leaf) => leaf.field !== 'is_open_item'),
        `${slug} must not filter on is_open_item: tracked is not unpaid`,
      )
    })
  }

  it('the openness flag compiles to SQL on the ledger_lines entity', () => {
    const entity = REPORT_ENTITY_MAP.ledger_lines
    assert.ok(entity, 'ledger_lines entity must exist')
    assert.ok(
      entity.columns.some((column) => column.key === 'has_open_balance'),
      'ledger_lines must expose the application-aware openness flag',
    )
    const sql = compileRule(entity, { column: 'has_open_balance', op: 'is_true' }, new SqlParams())
    assert.ok(sql, 'the openness filter must compile')
  })
})
