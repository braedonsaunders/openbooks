import 'server-only'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { add, mul } from '@openbooks/engine/src/money/money.ts'
import { laborCostingSettings, laborFxRate, convertLaborWage, convertFixedLaborComponents, resolveWage, computeCostRate } from '@openbooks/engine/src/projects/labor-costing.ts'
import { weekStartOf } from '@openbooks/engine/src/resourcing/weeks.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { projects, parties, subsidiaries } from '@openbooks/schema'
import {
  MAX_AGGREGATE_MEASURES,
  MAX_FORMULA_MEASURES,
  shapeSummarizedRows,
  summarizeRows,
  utilizationEntity,
  benchEntity,
  capacityDemandEntity,
  engagementEntity,
  type InMemoryReportMeasure,
  type ReportFormulaExpr,
  type ReportRunLabels,
  type ReportRunResult,
  type SummarizeRowsPlan,
} from '@openbooks/reports'
import { resolveItemRate } from '../item-rates'
import { loadDemandWeeks } from './demand'
import { loadResourcingBoard, type StaffablePerson } from './queries'
import { subsidiaryVisibleFilter } from '../subsidiaries'

export { RESOURCING_REPORT_ENTITIES, utilizationEntity, benchEntity, capacityDemandEntity, engagementEntity } from '@openbooks/reports'

export type ResourcingReportKey = 'utilization' | 'bench' | 'capacity-demand' | 'engagement'
export type ResourcingBreakout = 'person' | 'department' | 'job_title' | 'project' | 'customer'

export type ResourcingReportWindow = { firstSunday: string; lastSunday: string }
export type ResourcingReportFilters = {
  departmentId?: string
  jobTitleSearch?: string
  breakout?: ResourcingBreakout
}

type FactPerson = StaffablePerson & { personLabel: string }
type ReportPopulation = {
  people: FactPerson[]
  personWeeks: Awaited<ReturnType<typeof loadResourcingBoard>>['forecast']['personWeeks']
  bench: Awaited<ReturnType<typeof loadResourcingBoard>>['forecast']['bench']
  genericDemand: Awaited<ReturnType<typeof loadResourcingBoard>>['forecast']['genericDemand']
  assignments: Awaited<ReturnType<typeof loadResourcingBoard>>['rows']
}

type ProjectInfo = {
  projectId: string
  projectName: string
  customerId: string | null
  customerName: string
  currency: string
}

type DepartmentLabelRow = { id: string; name: string }
type OrganizationCurrencyRow = { base_currency: string }

const formula = (
  key: string,
  expr: ReportFormulaExpr,
  format: 'ratio' | 'percent' | 'money' | 'number',
  label: string,
  undefinedLabel: string,
  guards: { measure: string; when: 'zero' | 'null'; label: string }[],
): InMemoryReportMeasure => ({ fn: 'formula', key, expr, format, label, undefinedLabel, guards })

export const RESOURCING_REPORT_PLANS = {
  utilization(labels: { utilization: string; booked: string; personCount: string; unknownCapacity: string; noCapacity: string; undefined: string }, breakout: ResourcingBreakout = 'department'): SummarizeRowsPlan {
    const measures: InMemoryReportMeasure[] = [
      { fn: 'sum', key: 'capacity', column: 'capacity' },
      { fn: 'sum', key: 'net_capacity', column: 'net_capacity' },
      { fn: 'sum', key: 'hard_billable', column: 'hard_billable' },
      { fn: 'sum', key: 'hard_non_billable', column: 'hard_non_billable' },
      { fn: 'sum', key: 'soft_hours', column: 'soft_hours' },
      { fn: 'count_distinct', key: 'people', column: 'person_id', label: labels.personCount },
      { fn: 'count', key: 'unknown_capacity', label: labels.unknownCapacity, filter: (row) => row.unknown_capacity === true },
      formula('utilization', { op: '/', left: { ref: 'hard_billable' }, right: { ref: 'net_capacity' } }, 'percent', labels.utilization, labels.undefined, [{ measure: 'net_capacity', when: 'zero', label: labels.noCapacity }]),
      formula('booked', {
        op: '/',
        left: { op: '+', left: { ref: 'hard_billable' }, right: { ref: 'hard_non_billable' } },
        right: { ref: 'net_capacity' },
      }, 'percent', labels.booked, labels.undefined, [{ measure: 'net_capacity', when: 'zero', label: labels.noCapacity }]),
    ]
    return { entity: utilizationEntity, breakouts: [{ column: 'week_start' }, { column: breakout }], timeKey: 'week_start', measures }
  },
  bench(breakout: ResourcingBreakout = 'department', peopleLabel = 'People'): SummarizeRowsPlan {
    return {
      entity: benchEntity,
      breakouts: [{ column: 'week_start' }, { column: breakout }],
      timeKey: 'week_start',
      measures: [
        { fn: 'count_distinct', key: 'people', column: 'person_id', label: peopleLabel },
        { fn: 'sum', key: 'idle_capacity', column: 'idle_net_capacity' },
      ],
    }
  },
  capacityDemand(labels: { gap: string; fill: string; personCount: string; unknownCapacity: string; noCapacity: string; undefined: string }, breakout: ResourcingBreakout = 'job_title'): SummarizeRowsPlan {
    return {
      entity: capacityDemandEntity,
      breakouts: [{ column: 'week_start' }, { column: breakout }],
      timeKey: 'week_start',
      measures: [
        { fn: 'sum', key: 'capacity', column: 'capacity' },
        { fn: 'sum', key: 'named_hard', column: 'named_hard' },
        { fn: 'sum', key: 'named_soft', column: 'named_soft' },
        { fn: 'sum', key: 'generic_hard', column: 'generic_hard' },
        { fn: 'sum', key: 'generic_soft', column: 'generic_soft' },
        { fn: 'sum', key: 'pipeline_demand', column: 'pipeline_demand' },
        { fn: 'count_distinct', key: 'people', column: 'person_id', label: labels.personCount },
        { fn: 'count', key: 'unknown_capacity', label: labels.unknownCapacity, filter: (row) => row.unknown_capacity === true },
        formula('gap', {
          op: '-',
          left: { op: '+', left: { op: '+', left: { op: '+', left: { ref: 'named_hard' }, right: { ref: 'named_soft' } }, right: { ref: 'generic_hard' } }, right: { op: '+', left: { ref: 'generic_soft' }, right: { ref: 'pipeline_demand' } } },
          right: { ref: 'capacity' },
        }, 'number', labels.gap, labels.undefined, []),
        formula('fill', {
          op: '/',
          left: { op: '+', left: { op: '+', left: { op: '+', left: { ref: 'named_hard' }, right: { ref: 'named_soft' } }, right: { ref: 'generic_hard' } }, right: { op: '+', left: { ref: 'generic_soft' }, right: { ref: 'pipeline_demand' } } },
          right: { ref: 'capacity' },
        }, 'percent', labels.fill, labels.undefined, [{ measure: 'capacity', when: 'zero', label: labels.noCapacity }]),
      ],
    }
  },
  engagement(labels: { margin: string; marginPercent: string; unpricedCount: string; uncostedCount: string; pricedCount: string; costedCount: string; noRevenue: string; noCost: string; undefined: string }, breakout: 'project' | 'customer' = 'project'): SummarizeRowsPlan {
    return {
      entity: engagementEntity,
      breakouts: [{ column: 'month' }, { column: breakout }, { column: 'currency' }, { column: 'bill_status' }, { column: 'cost_status' }],
      timeKey: 'week_start',
      // A combined revenue, cost, or margin card is honest only when every
      // contributing row is fully priced and costed. Any other row keeps its
      // own grouped row and guard label, while the shared shaper omits the
      // blended summary cards; hours and assignment counts still total.
      summaryPolicy: { incompleteRow: (row) => row.bill_status !== 'priced' || row.cost_status !== 'priced' },
      measures: [
        { fn: 'sum', key: 'hours', column: 'hours' },
        { fn: 'sum', key: 'revenue', column: 'revenue' },
        { fn: 'sum', key: 'cost', column: 'cost' },
        { fn: 'sum', key: 'unpriced_hours', column: 'unpriced_hours' },
        { fn: 'count', key: 'unpriced_count', label: labels.unpricedCount, filter: (row) => row.bill_status === 'no_bill_item' || row.bill_status === 'no_bill_rate' },
        { fn: 'count', key: 'uncosted_count', label: labels.uncostedCount, filter: (row) => row.cost_status !== 'priced' },
        { fn: 'count', key: 'priced_count', label: labels.pricedCount, filter: (row) => row.bill_status === 'priced' },
        { fn: 'count', key: 'costed_count', label: labels.costedCount, filter: (row) => row.cost_status === 'priced' },
        formula('margin', { op: '-', left: { ref: 'revenue' }, right: { ref: 'cost' } }, 'money', labels.margin, labels.undefined, [
          { measure: 'priced_count', when: 'zero', label: labels.noRevenue },
          { measure: 'costed_count', when: 'zero', label: labels.noCost },
        ]),
        formula('margin_percent', { op: '/', left: { ref: 'margin' }, right: { ref: 'revenue' } }, 'percent', labels.marginPercent, labels.undefined, [
          { measure: 'priced_count', when: 'zero', label: labels.noRevenue },
          { measure: 'costed_count', when: 'zero', label: labels.noCost },
          { measure: 'revenue', when: 'zero', label: labels.noRevenue },
        ]),
      ],
    }
  },
}

export function summarizeResourcingRows(
  key: ResourcingReportKey,
  rows: readonly Readonly<Record<string, unknown>>[],
  plan: SummarizeRowsPlan,
): ReportRunResult {
  const aggregateCount = plan.measures.filter((measure) => measure.fn !== 'formula').length
  const formulaCount = plan.measures.length - aggregateCount
  if (aggregateCount > MAX_AGGREGATE_MEASURES || formulaCount > MAX_FORMULA_MEASURES) {
    throw new Error(`The ${key} report exceeds the report engine's measure limits (${aggregateCount} aggregates, ${formulaCount} formulas). Reduce its declared measures.`)
  }
  // Contribute the input rows so the shared shaper observes denomination
  // singularity and pricing completeness from real values.
  return shapeSummarizedRows(summarizeRows(rows, plan), plan, rows)
}

async function loadPopulation(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  window: ResourcingReportWindow,
): Promise<ReportPopulation> {
  const people: FactPerson[] = []
  const personWeeks: ReportPopulation['personWeeks'] = []
  const bench: ReportPopulation['bench'] = []
  const genericDemand: ReportPopulation['genericDemand'] = []
  const assignments = new Map<string, ReportPopulation['assignments'][number]>()
  const occurrences = new Map<string, number>()
  let page = 1
  let pages = 1
  do {
    const board = await loadResourcingBoard(orgId, allowedSubsidiaryIds, {
      firstSunday: window.firstSunday,
      lastSunday: window.lastSunday,
      page,
      onDate: window.firstSunday,
    })
    for (const person of board.people) {
      const duplicate = occurrences.get(person.displayName) ?? 0
      occurrences.set(person.displayName, duplicate + 1)
      const personLabel = duplicate === 0 ? person.displayName : `${person.displayName} (${duplicate + 1})`
      people.push({ ...person, personLabel })
    }
    personWeeks.push(...board.forecast.personWeeks)
    bench.push(...board.forecast.bench)
    // Generic assignments have no employee key and the board includes them on
    // every employee page. Read them from the first page only.
    if (page === 1) genericDemand.push(...board.forecast.genericDemand)
    for (const assignment of board.rows) assignments.set(assignment.id, assignment)
    pages = Math.max(1, Math.ceil(board.total / board.pageSize))
    page += 1
  } while (page <= pages)
  return { people, personWeeks, bench, genericDemand, assignments: [...assignments.values()] }
}

function filterTextMatches(value: string | null | undefined, search: string | undefined): boolean {
  return !search || (value ?? '').toLocaleLowerCase().includes(search.toLocaleLowerCase())
}

async function departmentLabels(orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db.execute<DepartmentLabelRow>(sql`
    select id, name from departments where org_id = ${orgId} and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `)
  return new Map(rows.rows.map((row) => [row.id, row.name]))
}

function selectedPeople(population: ReportPopulation, filters: ResourcingReportFilters): FactPerson[] {
  return population.people.filter((person) =>
    (!filters.departmentId || person.departmentId === filters.departmentId)
      && filterTextMatches(person.jobTitle, filters.jobTitleSearch),
  )
}

function countPersonWeeks(population: ReportPopulation, people: readonly FactPerson[]): Map<string, typeof population.personWeeks[number]> {
  const included = new Set(people.map((person) => person.partyId))
  return new Map(population.personWeeks
    .filter((fact) => included.has(fact.employeePartyId))
    .map((fact) => [`${fact.employeePartyId}\u0000${fact.weekStart}`, fact]))
}

export async function loadUtilizationFacts(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  window: ResourcingReportWindow,
  filters: ResourcingReportFilters = {},
): Promise<Record<string, unknown>[]> {
  const population = await loadPopulation(orgId, allowedSubsidiaryIds, window)
  const people = selectedPeople(population, filters)
  const personById = new Map(people.map((person) => [person.partyId, person]))
  const departmentNames = await departmentLabels(orgId, [...new Set(people.flatMap((person) => person.departmentId ? [person.departmentId] : []))])
  return population.personWeeks.flatMap((fact) => {
    const person = personById.get(fact.employeePartyId)
    if (!person) return []
    const softHours = add(fact.softBillableHours, fact.softNonBillableHours)
    return [{
      week_start: fact.weekStart,
      person: person.personLabel,
      person_id: person.partyId,
      department: person.departmentId ? departmentNames.get(person.departmentId) ?? null : null,
      job_title: person.jobTitle,
      capacity: fact.capacity?.hours,
      net_capacity: fact.netCapacity,
      hard_billable: fact.hardBillableHours,
      hard_non_billable: fact.hardNonBillableHours,
      soft_hours: softHours,
      unknown_capacity: fact.netCapacity === null,
    }]
  })
}

export async function loadBenchFacts(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  window: ResourcingReportWindow,
  filters: ResourcingReportFilters = {},
): Promise<Record<string, unknown>[]> {
  const population = await loadPopulation(orgId, allowedSubsidiaryIds, window)
  const people = selectedPeople(population, filters)
  const personById = new Map(people.map((person) => [person.partyId, person]))
  const factByKey = countPersonWeeks(population, people)
  const departmentNames = await departmentLabels(orgId, [...new Set(people.flatMap((person) => person.departmentId ? [person.departmentId] : []))])
  return population.bench.flatMap((personBench) => {
    const person = personById.get(personBench.employeePartyId)
    if (!person) return []
    return personBench.weekStarts.flatMap((weekStart) => {
      const fact = factByKey.get(`${person.partyId}\u0000${weekStart}`)
      if (!fact || !fact.netCapacity) return []
      return [{
        week_start: weekStart,
        department: person.departmentId ? departmentNames.get(person.departmentId) ?? null : null,
        job_title: person.jobTitle,
        person_id: person.partyId,
        idle_net_capacity: fact.netCapacity,
      }]
    })
  })
}

export async function loadCapacityDemandFacts(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  window: ResourcingReportWindow,
  filters: ResourcingReportFilters = {},
): Promise<Record<string, unknown>[]> {
  const population = await loadPopulation(orgId, allowedSubsidiaryIds, window)
  const people = selectedPeople(population, filters)
  const personById = new Map(people.map((person) => [person.partyId, person]))
  const departmentNames = await departmentLabels(orgId, [...new Set(people.flatMap((person) => person.departmentId ? [person.departmentId] : []))])
  const rows: Record<string, unknown>[] = []
  for (const fact of population.personWeeks) {
    const person = personById.get(fact.employeePartyId)
    if (!person) continue
    rows.push({
      week_start: fact.weekStart,
      department: person.departmentId ? departmentNames.get(person.departmentId) ?? null : null,
      job_title: person.jobTitle,
      person_id: person.partyId,
      capacity: fact.netCapacity,
      named_hard: add(fact.hardBillableHours, fact.hardNonBillableHours),
      named_soft: add(fact.softBillableHours, fact.softNonBillableHours),
      generic_hard: null,
      generic_soft: null,
      pipeline_demand: null,
      unknown_capacity: fact.netCapacity === null,
    })
  }
  for (const fact of population.genericDemand) {
    if (filters.departmentId || !filterTextMatches(fact.jobTitle, filters.jobTitleSearch)) continue
    rows.push({
      week_start: fact.weekStart,
      department: null,
      job_title: fact.jobTitle,
      person_id: null,
      capacity: null,
      named_hard: null,
      named_soft: null,
      generic_hard: fact.hardHours,
      generic_soft: fact.softHours,
      pipeline_demand: null,
      unknown_capacity: false,
    })
  }
  const demand = await loadDemandWeeks(orgId, allowedSubsidiaryIds, window)
  const demandDepartmentIds = [...new Set(demand.flatMap((fact) => fact.departmentId ? [fact.departmentId] : []))]
  const demandDepartments = await departmentLabels(orgId, demandDepartmentIds)
  for (const fact of demand) {
    if (fact.basis !== 'pipeline'
      || (filters.departmentId && fact.departmentId !== filters.departmentId)
      || !filterTextMatches(fact.jobTitle, filters.jobTitleSearch)) continue
    rows.push({
      week_start: fact.weekStart,
      department: demandDepartments.get(fact.departmentId) ?? null,
      job_title: fact.jobTitle,
      person_id: null,
      capacity: null,
      named_hard: null,
      named_soft: null,
      generic_hard: null,
      generic_soft: null,
      pipeline_demand: fact.weightedHours,
      unknown_capacity: false,
    })
  }
  return rows
}

async function projectInfo(
  orgId: string,
  projectIds: readonly string[],
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<Map<string, ProjectInfo>> {
  if (projectIds.length === 0) return new Map()
  const visibleProjects = subsidiaryVisibleFilter(sql`${projects.subsidiaryId}`, allowedSubsidiaryIds)
  const rows = await db.select({
    projectId: projects.id,
    projectName: projects.name,
    customerId: projects.customerId,
    customerName: parties.displayName,
    currency: sql<string>`coalesce(${subsidiaries.baseCurrency}, (select base_currency from orgs where id = ${projects.orgId}))`,
  }).from(projects)
    .leftJoin(parties, and(eq(parties.orgId, projects.orgId), eq(parties.id, projects.customerId)))
    .leftJoin(subsidiaries, and(eq(subsidiaries.orgId, projects.orgId), eq(subsidiaries.id, projects.subsidiaryId)))
    .where(sql`${and(eq(projects.orgId, orgId), inArray(projects.id, [...new Set(projectIds)]))}${visibleProjects}`)
  return new Map(rows.map((row) => [row.projectId, {
    projectId: row.projectId,
    projectName: row.projectName ?? '',
    customerId: row.customerId,
    customerName: row.customerName ?? '',
    currency: row.currency,
  }]))
}

export async function loadEngagementFacts(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  window: ResourcingReportWindow,
  filters: ResourcingReportFilters = {},
): Promise<Record<string, unknown>[]> {
  const population = await loadPopulation(orgId, allowedSubsidiaryIds, window)
  const people = selectedPeople(population, filters)
  const personById = new Map(people.map((person) => [person.partyId, person]))
  const assignments = population.assignments.filter((assignment) =>
    assignment.state === 'active'
      && weekStartOf(assignment.weekStart) === assignment.weekStart
      && (!filters.departmentId || assignment.employeePartyId !== null)
      && filterTextMatches(assignment.jobTitle ?? personById.get(assignment.employeePartyId ?? '')?.jobTitle, filters.jobTitleSearch),
  )
  const projectsById = await projectInfo(orgId, assignments.map((assignment) => assignment.projectId), allowedSubsidiaryIds)
  const settings = await laborCostingSettings(orgId)
  const orgCurrency = (await db.execute<OrganizationCurrencyRow>(sql`select base_currency from orgs where id = ${orgId}`)).rows[0]?.base_currency ?? 'USD'
  const departmentNames = await departmentLabels(orgId, [...new Set(people.flatMap((person) => person.departmentId ? [person.departmentId] : []))])
  const output: Record<string, unknown>[] = []
  for (const assignment of assignments) {
    const person = assignment.employeePartyId ? personById.get(assignment.employeePartyId) : undefined
    if (assignment.employeePartyId && !person) continue
    const project = projectsById.get(assignment.projectId)
    if (!project) continue
    const weekStart = assignment.weekStart
    const targetCurrency = project.currency || orgCurrency
    const hasBillItem = assignment.billItemId !== null
    const billRate = assignment.isBillable && hasBillItem ? await resolveItemRate({
      orgId,
      projectId: assignment.projectId,
      itemId: assignment.billItemId!,
      onDate: weekStart,
      departmentId: person?.departmentId,
      baseQuantity: assignment.plannedHours,
      allowedSubsidiaryIds,
    }) : null
    let cost: string | null = null
    let costResolved = false
    let costStatus = person ? 'no_cost_rate' : 'no_employee'
    if (person) {
      const wage = await resolveWage(orgId, person.partyId, weekStart, {
        jobTitle: person.jobTitle,
        departmentId: person.departmentId,
        annualHoursDefault: settings.annualHours,
      })
      if (wage) {
        const wageFx = await laborFxRate(orgId, wage.currency, targetCurrency, weekStart)
        const componentFx = await laborFxRate(orgId, orgCurrency, targetCurrency, weekStart)
        if (wageFx && componentFx) {
          const rate = computeCostRate(
            convertLaborWage(wage.wage, wageFx),
            '1.0000',
            { ...settings, components: convertFixedLaborComponents(settings.components, componentFx) },
          )
          cost = mul(assignment.plannedHours, rate)
          costResolved = true
          costStatus = 'priced'
        } else {
          costStatus = 'no_cost_fx'
        }
      }
    }
    const billResolved = !assignment.isBillable || billRate !== null
    const billAmount = assignment.isBillable && billRate ? billRate.bill.amount : null
    const billStatus = !assignment.isBillable ? 'non_billable' : !hasBillItem ? 'no_bill_item' : billRate === null ? 'no_bill_rate' : 'priced'
    output.push({
      week_start: weekStart,
      month: weekStart.slice(0, 7),
      project: project.projectName,
      customer: project.customerName || null,
      currency: billRate?.targetCurrency ?? targetCurrency,
      department: person?.departmentId ? departmentNames.get(person.departmentId) ?? null : null,
      job_title: person?.jobTitle ?? assignment.jobTitle,
      bill_status: billStatus,
      cost_status: costStatus,
      hours: assignment.plannedHours,
      revenue: billAmount,
      cost: costResolved ? cost : null,
      unpriced_hours: assignment.isBillable && !billResolved ? assignment.plannedHours : '0.0000',
      unpriced_count: assignment.isBillable && !billResolved,
      uncosted_count: !costResolved,
    })
  }
  return output
}

export async function runResourcingReport(
  key: ResourcingReportKey,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  window: ResourcingReportWindow,
  filters: ResourcingReportFilters,
  labels: {
    report: ReportRunLabels
    formulas: {
      utilization: string; booked: string; gap: string; fill: string; margin: string; marginPercent: string; personCount: string;
      unknownCapacity: string; unpricedCount: string; uncostedCount: string; pricedCount: string; costedCount: string;
      noCapacity: string; noRevenue: string; noCost: string; undefined: string
    }
  },
): Promise<ReportRunResult> {
  const defaults: Record<ResourcingReportKey, ResourcingBreakout> = {
    utilization: 'department', bench: 'department', 'capacity-demand': 'job_title', engagement: 'project',
  }
  const allowed: Record<ResourcingReportKey, readonly ResourcingBreakout[]> = {
    utilization: ['person', 'department', 'job_title'],
    bench: ['department', 'job_title'],
    'capacity-demand': ['job_title', 'department'],
    engagement: ['project', 'customer'],
  }
  const breakout = filters.breakout && allowed[key].includes(filters.breakout) ? filters.breakout : defaults[key]
  let rows: Record<string, unknown>[]
  let plan: SummarizeRowsPlan
  switch (key) {
    case 'utilization':
      rows = await loadUtilizationFacts(orgId, allowedSubsidiaryIds, window, filters)
      plan = RESOURCING_REPORT_PLANS.utilization(labels.formulas, breakout)
      break
    case 'bench':
      rows = await loadBenchFacts(orgId, allowedSubsidiaryIds, window, filters)
      plan = RESOURCING_REPORT_PLANS.bench(breakout, labels.formulas.personCount)
      break
    case 'capacity-demand':
      rows = await loadCapacityDemandFacts(orgId, allowedSubsidiaryIds, window, filters)
      plan = RESOURCING_REPORT_PLANS.capacityDemand(labels.formulas, breakout)
      break
    case 'engagement':
      rows = await loadEngagementFacts(orgId, allowedSubsidiaryIds, window, filters)
      plan = RESOURCING_REPORT_PLANS.engagement(labels.formulas, breakout === 'customer' ? 'customer' : 'project')
      break
  }
  plan.labels = labels.report
  return summarizeResourcingRows(key, rows, plan)
}
