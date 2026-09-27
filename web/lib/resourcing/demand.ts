import 'server-only'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import type { resDemandLines } from '@openbooks/schema/src/resourcing.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { mulPercent } from '@openbooks/engine/src/money/money.ts'
import { ResourcingRefusal } from '@openbooks/engine/src/resourcing/errors.ts'
import { assertSundayWindow, weeksBetween } from '@openbooks/engine/src/resourcing/weeks.ts'
import { crmOpportunityInPipeline } from '../crm.ts'
import { crmOpportunityScope } from '../crm-scope.ts'
import { subsidiaryVisibleFilter } from '../subsidiaries.ts'
import { isFeatureEnabled } from '../features.ts'

/**
 * Read demand from stored lines and current CRM facts. Hours are 4 dp decimal
 * strings; weighted hours use mulPercent(hours, probability), rounded half
 * away from zero to 4 dp.
 */
export type DemandExclusion = 'out_of_scope' | 'won' | 'closed' | 'omitted' | 'inactive'

type DemandBasis = 'manual' | 'pipeline' | 'excluded'
type DemandWeight = {
  basis: DemandBasis
  weightedHours: string
  probability: number | null
  excludedReason: DemandExclusion | null
}

export type DemandWeek = {
  lineId: string
  departmentId: string
  jobTitle: string
  weekStart: string
  hoursPerWeek: string
  opportunityId: string | null
} & DemandWeight

type DemandLineInput = {
  hoursPerWeek: string
  opportunity: null | {
    inScope: boolean
    inPipeline: boolean
    isActive: boolean
    isClosed: boolean
    isWon: boolean
    forecastCategory: string
    probability: number
  }
}

/** Apply current CRM probability without mutating the stored staffing ask. */
export function weighDemandLine(line: DemandLineInput): DemandWeight {
  const opportunity = line.opportunity
  if (opportunity === null) {
    return { basis: 'manual', weightedHours: line.hoursPerWeek, probability: null, excludedReason: null }
  }
  if (!opportunity.inScope) {
    return { basis: 'excluded', weightedHours: '0.0000', probability: null, excludedReason: 'out_of_scope' }
  }

  const reason: DemandExclusion | null = opportunity.isWon
    ? 'won'
    : opportunity.isClosed
      ? 'closed'
      : opportunity.forecastCategory === 'omitted'
        ? 'omitted'
        : !opportunity.isActive
          ? 'inactive'
          : null
  if (opportunity.inPipeline) {
    if (reason !== null) throw new Error('CRM pipeline predicate includes an opportunity with an exclusion reason')
    return {
      basis: 'pipeline',
      weightedHours: mulPercent(line.hoursPerWeek, String(opportunity.probability)),
      probability: opportunity.probability,
      excludedReason: null,
    }
  }
  if (reason === null) throw new Error('CRM pipeline predicate excludes an opportunity without a named reason')
  return { basis: 'excluded', weightedHours: '0.0000', probability: opportunity.probability, excludedReason: reason }
}

type DemandLineRecord = typeof resDemandLines.$inferSelect
type DemandLineRow = {
  line_id: DemandLineRecord['id']
  department_id: DemandLineRecord['departmentId']
  job_title: DemandLineRecord['jobTitle']
  first_week: DemandLineRecord['firstWeek']
  last_week: DemandLineRecord['lastWeek']
  hours_per_week: DemandLineRecord['hoursPerWeek']
  opportunity_id: DemandLineRecord['opportunityId']
  opportunity_in_scope: boolean
  opportunity_in_pipeline: boolean | null
  opportunity_is_active: boolean | null
  opportunity_is_closed: boolean | null
  opportunity_is_won: boolean | null
  opportunity_forecast_category: string | null
  opportunity_probability: number | null
}

/** Expand visible demand lines into the requested Sunday weeks. */
export async function loadDemandWeeks(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  window: { firstSunday: string; lastSunday: string; departmentId?: string; jobTitle?: string },
): Promise<DemandWeek[]> {
  if (!(await isFeatureEnabled(orgId, 'resourcing'))) notFound()
  const weekCount = assertSundayWindow(window.firstSunday, window.lastSunday)
  if (weekCount > 53) {
    throw new ResourcingRefusal(
      422,
      'demand_window_too_large',
      `demand window contains ${weekCount} Sundays; the maximum is 53`,
      'request 53 weeks or fewer',
    )
  }

  const departmentFilter = window.departmentId ? sql`and dl.department_id = ${window.departmentId}` : sql``
  const jobTitleFilter = window.jobTitle ? sql`and dl.job_title = ${window.jobTitle}` : sql``
  const rows = (await db.execute<DemandLineRow>(sql`
    select dl.id as line_id, dl.department_id, dl.job_title,
           dl.first_week::text as first_week, dl.last_week::text as last_week,
           dl.hours_per_week::text as hours_per_week, dl.opportunity_id,
           exists (
             select 1 from crm_opportunities o
              where o.id = dl.opportunity_id and o.org_id = dl.org_id
                ${crmOpportunityScope(allowedSubsidiaryIds)}
           ) as opportunity_in_scope,
           ${crmOpportunityInPipeline(sql`${sql.identifier('opportunity')}`, sql`${sql.identifier('opportunity_status')}`)} as opportunity_in_pipeline,
           opportunity.is_active as opportunity_is_active,
           opportunity_status.is_closed as opportunity_is_closed,
           opportunity_status.is_won as opportunity_is_won,
           opportunity.forecast_category as opportunity_forecast_category,
           opportunity.probability as opportunity_probability
      from res_demand_lines dl
      join departments d on d.id = dl.department_id and d.org_id = dl.org_id
      left join crm_opportunities opportunity
        on opportunity.id = dl.opportunity_id and opportunity.org_id = dl.org_id
      left join crm_opportunity_statuses opportunity_status
        on opportunity_status.id = opportunity.status_id and opportunity_status.org_id = opportunity.org_id
     where dl.org_id = ${orgId}
       and dl.first_week <= ${window.lastSunday}::date
       and dl.last_week >= ${window.firstSunday}::date
       ${departmentFilter}${jobTitleFilter}
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `)).rows

  const demand: DemandWeek[] = []
  for (const row of rows) {
    let opportunity: DemandLineInput['opportunity'] = null
    if (row.opportunity_id !== null) {
      if (
        row.opportunity_in_pipeline === null || row.opportunity_is_active === null ||
        row.opportunity_is_closed === null || row.opportunity_is_won === null ||
        row.opportunity_forecast_category === null || row.opportunity_probability === null
      ) {
        throw new Error('linked CRM opportunity is missing pipeline facts')
      }
      opportunity = {
        inScope: row.opportunity_in_scope,
        inPipeline: row.opportunity_in_pipeline,
        isActive: row.opportunity_is_active,
        isClosed: row.opportunity_is_closed,
        isWon: row.opportunity_is_won,
        forecastCategory: row.opportunity_forecast_category,
        probability: row.opportunity_probability,
      }
    }
    const weight = weighDemandLine({ hoursPerWeek: row.hours_per_week, opportunity })
    const firstWeek = row.first_week < window.firstSunday ? window.firstSunday : row.first_week
    const lastWeek = row.last_week > window.lastSunday ? window.lastSunday : row.last_week
    for (const weekStart of weeksBetween(firstWeek, lastWeek)) {
      demand.push({
        lineId: row.line_id,
        departmentId: row.department_id,
        jobTitle: row.job_title,
        weekStart,
        hoursPerWeek: row.hours_per_week,
        opportunityId: weight.excludedReason === 'out_of_scope' ? null : row.opportunity_id,
        ...weight,
      })
    }
  }
  demand.sort((a, b) =>
    a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1
      : a.jobTitle < b.jobTitle ? -1 : a.jobTitle > b.jobTitle ? 1
        : a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0,
  )
  return demand
}
