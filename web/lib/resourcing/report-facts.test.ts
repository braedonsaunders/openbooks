import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_AGGREGATE_MEASURES, MAX_FORMULA_MEASURES, shapeSummarizedRows, summarizeRows } from '@openbooks/reports'
import { RESOURCING_REPORT_PLANS, benchEntity, capacityDemandEntity, engagementEntity, summarizeResourcingRows, utilizationEntity } from './report-facts.ts'

const formulas = {
  utilization: 'Utilization',
  booked: 'Booked',
  gap: 'Demand gap',
  fill: 'Capacity fill',
  margin: 'Margin',
  marginPercent: 'Margin percent',
  personCount: 'People',
  unknownCapacity: 'Unknown capacity weeks',
  unpricedCount: 'Unpriced assignments',
  uncostedCount: 'Uncosted assignments',
  pricedCount: 'Priced assignments',
  costedCount: 'Costed assignments',
  noCapacity: 'No capacity recorded',
  noRevenue: 'No revenue recorded',
  noCost: 'No labor cost recorded',
  undefined: 'Undefined',
}

function shape(rows: Record<string, unknown>[], plan: ReturnType<typeof RESOURCING_REPORT_PLANS.utilization>) {
  return shapeSummarizedRows(summarizeRows(rows, plan), plan, rows)
}

test('in-memory resourcing plans shape totals, guards, and currency breakouts through the shared result', () => {
  const utilizationPlan = RESOURCING_REPORT_PLANS.utilization(formulas, 'department')
  const utilizationRows = [
    { week_start: '2026-04-05', department: 'Delivery', person: 'Ada', person_id: 'person-a', job_title: 'Analyst', capacity: '1.0000', net_capacity: '1.0000', hard_billable: '1.0000', hard_non_billable: '0.0000', soft_hours: '0.0000', unknown_capacity: false },
    { week_start: '2026-04-05', department: 'Delivery', person: 'Bea', person_id: 'person-b', job_title: 'Analyst', capacity: '9.0000', net_capacity: '9.0000', hard_billable: '0.0000', hard_non_billable: '0.0000', soft_hours: '0.0000', unknown_capacity: false },
  ]
  const utilization = shape(utilizationRows, utilizationPlan)
  const utilizationGroup = utilization.groups[0]!
  const utilizationColumn = utilizationGroup.columns.indexOf('Utilization')
  assert.equal(utilizationGroup.rows[0]?.[utilizationColumn], '10.00%', 'the ratio uses 1 / 10 from component totals, not the average of 100% and 0%')

  const guarded = shape([{
    week_start: '2026-04-12', department: 'Advisory', person: 'Cam', person_id: 'person-c', job_title: 'Consultant',
    capacity: '0.0000', net_capacity: '0.0000', hard_billable: '0.0000', hard_non_billable: '0.0000', soft_hours: '0.0000', unknown_capacity: false,
  }], utilizationPlan)
  const guardedGroup = guarded.groups[0]!
  const guardedColumn = guardedGroup.columns.indexOf('Utilization')
  assert.equal(guardedGroup.undefinedCells?.[0]?.[guardedColumn], formulas.noCapacity)

  const benchPlan = RESOURCING_REPORT_PLANS.bench('department')
  const benchRows = [{
    week_start: '2026-04-05', department: 'Delivery', job_title: 'Analyst', person_id: 'person-a', idle_net_capacity: '8.0000',
  }]
  const bench = shapeSummarizedRows(summarizeRows(benchRows, benchPlan), benchPlan, benchRows)
  assert.equal(bench.groups[0]?.rows.length, 1)

  const capacityPlan = RESOURCING_REPORT_PLANS.capacityDemand(formulas, 'job_title')
  const capacityRows = [{
    week_start: '2026-04-05', department: 'Delivery', job_title: 'Analyst', person_id: 'person-a',
    capacity: '8.0000', named_hard: '2.0000', named_soft: '1.0000', generic_hard: '0.0000',
    generic_soft: '0.0000', pipeline_demand: '3.0000', unknown_capacity: false,
  }]
  const capacity = shapeSummarizedRows(summarizeRows(capacityRows, capacityPlan), capacityPlan, capacityRows)
  assert.equal(capacity.groups[0]?.rows.length, 1)

  const engagementPlan = RESOURCING_REPORT_PLANS.engagement(formulas, 'project')
  const engagementRows = [
    { week_start: '2026-04-05', month: '2026-04', project: 'Orion', customer: 'Northwind', currency: 'USD', department: 'Delivery', job_title: 'Analyst', bill_status: 'priced', cost_status: 'priced', hours: '1.0000', revenue: '10.0000', cost: '6.0000', unpriced_hours: '0.0000', unpriced_count: false, uncosted_count: false },
    { week_start: '2026-04-05', month: '2026-04', project: 'Orion', customer: 'Northwind', currency: 'CAD', department: 'Delivery', job_title: 'Analyst', bill_status: 'priced', cost_status: 'priced', hours: '1.0000', revenue: '20.0000', cost: '12.0000', unpriced_hours: '0.0000', unpriced_count: false, uncosted_count: false },
  ]
  const engagement = shapeSummarizedRows(summarizeRows(engagementRows, engagementPlan), engagementPlan, engagementRows)
  const engagementGroup = engagement.groups[0]!
  assert.deepEqual(engagementGroup.rows.map((row) => [row[2], row[6]]), [['CAD', '20.0000'], ['USD', '10.0000']])
  const unpricedRows = [{
    week_start: '2026-04-05', month: '2026-04', project: 'Orion', customer: 'Northwind', currency: 'USD', department: 'Delivery', job_title: 'Analyst',
    bill_status: 'no_bill_rate', cost_status: 'priced', hours: '1.0000', revenue: null, cost: '6.0000', unpriced_hours: '1.0000', unpriced_count: true, uncosted_count: false,
  }]
  const unpriced = shapeSummarizedRows(summarizeRows(unpricedRows, engagementPlan), engagementPlan, unpricedRows)
  const unpricedGroup = unpriced.groups[0]!
  assert.equal(unpricedGroup.undefinedCells?.[0]?.[unpricedGroup.columns.indexOf('Margin')], 'No revenue recorded')

  for (const [key, plan] of [
    ['utilization', utilizationPlan], ['bench', benchPlan], ['capacity-demand', capacityPlan], ['engagement', engagementPlan],
  ] as const) {
    const aggregates = plan.measures.filter((measure) => measure.fn !== 'formula')
    const formulasInPlan = plan.measures.filter((measure) => measure.fn === 'formula')
    assert.ok(aggregates.length <= MAX_AGGREGATE_MEASURES)
    assert.ok(formulasInPlan.length <= MAX_FORMULA_MEASURES)
    assert.ok(summarizeResourcingRows(key, [], plan))
  }

  assert.equal(utilizationEntity.key, 'resourcing_utilization')
  assert.equal(benchEntity.key, 'resourcing_bench')
  assert.equal(capacityDemandEntity.key, 'resourcing_capacity_demand')
  assert.equal(engagementEntity.key, 'resourcing_engagement')
})

function engagementRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    week_start: '2026-04-05', month: '2026-04', project: 'Orion', customer: 'Northwind', currency: 'USD',
    department: 'Delivery', job_title: 'Analyst', bill_status: 'priced', cost_status: 'priced',
    hours: '1.0000', revenue: '10.0000', cost: '6.0000', unpriced_hours: '0.0000',
    unpriced_count: false, uncosted_count: false, ...overrides,
  }
}

function summaryOf(result: ReturnType<typeof summarizeResourcingRows>): Map<string, unknown> {
  return new Map(result.summary.map((item) => [item.label, item.value]))
}

test('engagement summaries suppress blended money while exact single-currency totals stay', () => {
  const plan = RESOURCING_REPORT_PLANS.engagement(formulas, 'project')

  const mixed = summarizeResourcingRows('engagement', [
    engagementRow({}),
    engagementRow({ currency: 'CAD', revenue: '20.0000', cost: '12.0000' }),
  ], plan)
  assert.equal(mixed.groups[0]?.rows.length, 2, 'per-currency group rows stay partitioned')
  const mixedSummary = summaryOf(mixed)
  assert.ok(![...mixedSummary.keys()].some((label) => /forecast revenue|forecast cost|margin/i.test(label)),
    `USD+CAD must publish no monetary or margin summary card, got ${[...mixedSummary.keys()].join(', ')}`)
  assert.equal(mixedSummary.get('Total sum of hours'), '2.00', 'safe hours still total')
  assert.equal(mixedSummary.get('Total priced assignments'), 2, 'safe counts still total')

  const partial = summarizeResourcingRows('engagement', [
    engagementRow({}),
    engagementRow({ bill_status: 'no_bill_rate', revenue: null, unpriced_hours: '1.0000', unpriced_count: true }),
  ], plan)
  const partialSummary = summaryOf(partial)
  assert.ok(![...partialSummary.keys()].some((label) => /forecast revenue|forecast cost|margin/i.test(label)),
    `priced plus unpriced rows must publish no partial margin, got ${[...partialSummary.keys()].join(', ')}`)
  assert.equal(partialSummary.get('Total sum of hours'), '2.00')
  assert.equal(partialSummary.get('Total priced assignments'), 1)
  assert.equal(partialSummary.get('Total unpriced assignments'), 1)

  const exact = summarizeResourcingRows('engagement', [
    engagementRow({}),
    engagementRow({ revenue: '20.0000', cost: '12.0000' }),
  ], plan)
  const exactSummary = summaryOf(exact)
  assert.equal(exactSummary.get('Total sum of hours'), '2.00')
  assert.equal(exactSummary.get('Total sum of forecast revenue'), '30.00')
  assert.equal(exactSummary.get('Total sum of forecast cost'), '18.00')
  assert.equal(exactSummary.get('Total margin'), '12.0000')
  assert.equal(exactSummary.get('Total margin percent'), '40.00%')

  const nothingPriced = summarizeResourcingRows('engagement', [
    engagementRow({ bill_status: 'no_bill_rate', revenue: null, unpriced_hours: '1.0000', unpriced_count: true }),
  ], plan)
  const nothingPricedSummary = summaryOf(nothingPriced)
  assert.equal(nothingPricedSummary.get('Total margin'), 'No revenue recorded', 'the zero-priced refusal still speaks')
  assert.ok(![...nothingPricedSummary.keys()].some((label) => /forecast revenue|forecast cost/i.test(label)))
})
