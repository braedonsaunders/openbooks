import 'server-only'
import { add } from '@openbooks/engine/src/money/money.ts'
import { addCalendarDays, businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { weekStartOf } from '@openbooks/engine/src/resourcing/weeks.ts'
import { loadResourcingBoard } from './queries'
import { loadUtilizationFacts, RESOURCING_REPORT_PLANS, summarizeResourcingRows } from './report-facts'
import { reportRunLabels } from '../report-labels'

/**
 * Resourcing module home — the staffing cockpit vitals over the next four
 * weeks: capacity, bench, rolloff and overallocation aggregates paged from
 * the landed board/forecast readers, plus the utilization total evaluated by
 * the landed utilization plan through the shared report summarizer. Hours
 * stay decimal strings and no ratio is computed here.
 */

export interface ResourcingHome {
  /** First Sunday of the four-week vitals window. */
  firstSunday: string;
  lastSunday: string;
  /** Summed net capacity over the window, decimal string. */
  netCapacity: string;
  benchPeople: number;
  rolloffs: number;
  /** Person-weeks whose hard bookings exceed net capacity. */
  overallocatedWeeks: number;
  /** People with unknown capacity in the window. */
  unknownCapacityPeople: number;
  /** Utilization summary-card value exactly as the shared shaper formats it
   *  (a percent string such as "10.00%"), or null when the guard refuses. */
  utilization: string | null;
}

export async function resourcingHome(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ResourcingHome> {
  const firstSunday = weekStartOf(await businessToday(orgId))
  const lastSunday = addCalendarDays(firstSunday, 21)
  const netCapacities: string[] = []
  const bench = new Set<string>()
  const rolloffs = new Set<string>()
  const unknownCapacity = new Set<string>()
  let overallocatedWeeks = 0
  let page = 1
  let pages = 1
  do {
    const board = await loadResourcingBoard(orgId, allowedSubsidiaryIds, {
      firstSunday,
      lastSunday,
      onDate: firstSunday,
      page,
    })
    for (const fact of board.forecast.personWeeks) {
      if (fact.netCapacity !== null) netCapacities.push(fact.netCapacity)
      else unknownCapacity.add(fact.employeePartyId)
      if (fact.overallocated === true) overallocatedWeeks += 1
    }
    for (const person of board.forecast.bench) bench.add(person.employeePartyId)
    for (const person of board.forecast.rolloffs) rolloffs.add(person.employeePartyId)
    pages = Math.max(1, Math.ceil(board.total / board.pageSize))
    page += 1
  } while (page <= pages)

  const utilization = await utilizationTotal(orgId, allowedSubsidiaryIds, firstSunday, lastSunday)
  return {
    firstSunday,
    lastSunday,
    netCapacity: netCapacities.reduce((total, hours) => add(total, hours), '0.0000'),
    benchPeople: bench.size,
    rolloffs: rolloffs.size,
    overallocatedWeeks,
    unknownCapacityPeople: unknownCapacity.size,
    utilization,
  }
}

/**
 * The utilization tile value, evaluated by the landed utilization plan over
 * the contributor rows and shaped by the shared summarizer — the same
 * computation as the utilization report, so the tile ties to it. The formula
 * evaluator scales percent measures by 100, so the total reads in percent
 * units; a guarded (zero-capacity) total is absent and reads as null.
 */
async function utilizationTotal(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  firstSunday: string,
  lastSunday: string,
): Promise<string | null> {
  const { getTranslations } = await import('next-intl/server')
  const t = await getTranslations('resourcing.reports.utilization')
  const rows = await loadUtilizationFacts(orgId, allowedSubsidiaryIds, { firstSunday, lastSunday })
  const utilizationLabel = t('measures.utilization')
  const plan = RESOURCING_REPORT_PLANS.utilization({
    utilization: utilizationLabel,
    booked: t('measures.booked'),
    personCount: t('measures.personCount'),
    unknownCapacity: t('measures.unknownCapacity'),
    noCapacity: t('guards.noCapacity'),
    undefined: t('guards.undefined'),
  })
  const runLabels = await reportRunLabels()
  plan.labels = runLabels
  const result = summarizeResourcingRows('utilization', rows, plan)
  // Summary cards are labeled through the shared run labels, never the raw
  // measure label: the utilization card reads like "Total utilization".
  const cardLabel = runLabels.summaryTotal?.(utilizationLabel) ?? `Total ${utilizationLabel.toLowerCase()}`
  const item = result.summary.find((entry) => entry.label === cardLabel)
  if (!item || item.value === null || item.value === undefined || item.value === '') return null
  // A computed refusal still speaks: the guard publishes its named label as
  // the card value. That is not a figure — it reads as unknown capacity.
  const refusal = new Set([t('guards.noCapacity'), t('guards.undefined'), runLabels.undefinedFormula?.() ?? 'Undefined — divides by zero'])
  if (typeof item.value === 'string' && refusal.has(item.value)) return null
  // Percent formula values arrive formatted by the shared shaper (such as
  // "10.00%"): display the card value byte-for-byte, never re-suffixed.
  return String(item.value)
}
