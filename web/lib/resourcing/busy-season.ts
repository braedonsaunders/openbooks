import 'server-only'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { add, cmp, neg } from '@openbooks/engine/src/money/money.ts'
import { addCalendarDays } from '@openbooks/engine/src/platform/business-date.ts'
import { ResourcingRefusal } from '@openbooks/engine/src/resourcing/errors.ts'
import {
  assertPlannableCapacity,
  type AvailabilityFigure,
} from '@openbooks/engine/src/resourcing/availability.ts'
import { readAvailability } from '@openbooks/engine/src/resourcing/availability-read.ts'
import { assertSundayWindow } from '@openbooks/engine/src/resourcing/weeks.ts'
import { loadDemandWeeks } from './demand.ts'
import { loadStaffablePeople, type StaffablePerson } from './queries.ts'
import { subsidiaryVisibleFilter } from '../subsidiaries.ts'
import { isFeatureEnabled } from '../features.ts'

/**
 * Busy-season capacity: department demand curves over the stored plan and the
 * stored asks, read against net capacity.
 *
 * The seasonal spans are derived from data, never a calendar table: distinct
 * weeks carrying active, in-scope generic plan assignments (no person) in the
 * requested year form one or more contiguous spans. Peak demand arrives as
 * generic rows, so those markers are the seasonal shape. With no markers
 * there are no gap rows. Inside those exact weeks every scoped active plan
 * assignment (named and generic) combines with the manual and live
 * pipeline-weighted demand lines, and net capacity comes only from the landed
 * availability reader. Hours stay 4 dp decimal strings; no ratio is stored or
 * computed here, and no computed gap is ever written back.
 *
 * Attribution is total or it refuses: a contributing row whose department
 * cannot be resolved exactly stops the load with a named refusal and a real
 * remedy, and a week whose load is positive but whose capacity is partly
 * unknown fails closed through the landed unknown-capacity classifier
 * instead of publishing a partial gap.
 */

export interface BusySeasonSpan {
  firstSunday: string
  lastSunday: string
}

export interface BusySeasonProject {
  id: string
  name: string
}

export interface BusySeasonEvidence {
  demandLineIds: string[]
  opportunityIds: string[]
  assignmentIds: string[]
  capacityPersonIds: string[]
  absenceRowIds: string[]
  holidayDates: string[]
}

export interface BusySeasonGap {
  departmentId: string
  departmentName: string
  weekStart: string
  demandHours: string
  planHardHours: string
  planSoftHours: string
  planHours: string
  capacityHours: string
  gapHours: string
  suggestedJobTitle: string
  evidence: BusySeasonEvidence
}

export interface BusySeasonData {
  seasonYear: string
  spans: BusySeasonSpan[]
  gaps: BusySeasonGap[]
  projects: BusySeasonProject[]
}

type MarkerRow = { week_start: string }
type DepartmentRow = { id: string; name: string }
type AssignmentRow = {
  id: string
  employee_party_id: string | null
  job_title: string | null
  person_name: string | null
  week_start: string
  planned_hours: string
  booking: string
}
type ProjectRow = { id: string; name: string }

type PersonInfo = {
  displayName: string
  departments: Set<string>
  /** Normalized title -> stored display form. */
  titles: Map<string, string>
}

/** One page of the staffable enumeration; the landed reader caps pages here. */
const STAFF_PAGE_SIZE = 50

/** Mirror the assignment writer's title match: trimmed, case-insensitive. */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase()
}

function contiguousSpans(weeks: string[]): BusySeasonSpan[] {
  const spans: BusySeasonSpan[] = []
  for (const week of weeks) {
    const current = spans[spans.length - 1]
    if (current && addCalendarDays(current.lastSunday, 7) === week) {
      current.lastSunday = week
    } else {
      spans.push({ firstSunday: week, lastSunday: week })
    }
  }
  return spans
}

function uniqueSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort()
}

/** Every scoped active employee, in deterministic order, across all pages. */
async function allStaffablePeople(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  onDate: string,
): Promise<StaffablePerson[]> {
  const first = await loadStaffablePeople(orgId, allowedSubsidiaryIds, { onDate, page: 1, pageSize: STAFF_PAGE_SIZE })
  const people = [...first.people]
  const pages = Math.max(1, Math.ceil(first.total / STAFF_PAGE_SIZE))
  for (let page = 2; page <= pages; page += 1) {
    const next = await loadStaffablePeople(orgId, allowedSubsidiaryIds, { onDate, page, pageSize: STAFF_PAGE_SIZE })
    people.push(...next.people)
  }
  return people
}

export async function loadBusySeason(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  season: { seasonYear: string },
): Promise<BusySeasonData> {
  if (!(await isFeatureEnabled(orgId, 'resourcing'))) notFound()
  if (!/^\d{4}$/.test(season.seasonYear)) {
    throw new Error(`busy-season year must be YYYY, got ${season.seasonYear}`)
  }
  const seasonYear = season.seasonYear
  const yearStart = `${seasonYear}-01-01`
  const yearEnd = `${Number(seasonYear) + 1}-01-01`

  const markers = (await db.execute<MarkerRow>(sql`
    select distinct a.week_start::text as week_start
      from res_assignments a
      join projects p on p.org_id = a.org_id and p.id = a.project_id
     where a.org_id = ${orgId}
       and a.state = 'active'
       and a.employee_party_id is null
       and a.week_start >= ${yearStart}::date and a.week_start < ${yearEnd}::date
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
     order by week_start
  `)).rows.map((row) => row.week_start)
  const spans = contiguousSpans(markers)
  if (spans.length === 0) {
    return { seasonYear, spans, gaps: [], projects: [] }
  }

  const departments = new Map((await db.execute<DepartmentRow>(sql`
    select d.id, d.name
      from departments d
     where d.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `)).rows.map((row) => [row.id, row.name] as const))

  const people = new Map<string, PersonInfo>()
  for (const person of await allStaffablePeople(orgId, allowedSubsidiaryIds, spans[0]!.firstSunday)) {
    let info = people.get(person.partyId)
    if (!info) {
      info = { displayName: person.displayName, departments: new Set(), titles: new Map() }
      people.set(person.partyId, info)
    }
    if (person.departmentId) info.departments.add(person.departmentId)
    if (person.jobTitle) {
      const key = normalizeTitle(person.jobTitle)
      if (key && !info.titles.has(key)) info.titles.set(key, person.jobTitle)
    }
  }

  const projects: BusySeasonProject[] = (await db.execute<ProjectRow>(sql`
    select p.id, p.name
      from projects p
     where p.org_id = ${orgId}
       and p.is_active
       and p.status not in ('closed', 'cancelled')
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
     order by p.name, p.id
  `)).rows

  const gaps: BusySeasonGap[] = []
  for (const span of spans) {
    const weekCount = assertSundayWindow(span.firstSunday, span.lastSunday)
    const [demand, assignments] = await Promise.all([
      loadDemandWeeks(orgId, allowedSubsidiaryIds, { firstSunday: span.firstSunday, lastSunday: span.lastSunday }),
      db.execute<AssignmentRow>(sql`
        select a.id, a.employee_party_id, a.job_title,
               person.display_name as person_name,
               a.week_start::text as week_start, a.planned_hours::text as planned_hours, a.booking
          from res_assignments a
          join projects p on p.org_id = a.org_id and p.id = a.project_id
          left join parties person on person.org_id = a.org_id and person.id = a.employee_party_id
         where a.org_id = ${orgId}
           and a.state = 'active'
           and a.week_start >= ${span.firstSunday}::date and a.week_start <= ${span.lastSunday}::date
           ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
         order by a.week_start, a.id
      `).then((result) => result.rows),
    ])

    const personIds = [...people.keys()]
    const chunkSize = Math.max(1, Math.floor(520 / weekCount))
    const figures: AvailabilityFigure[] = []
    for (let at = 0; at < personIds.length; at += chunkSize) {
      figures.push(...await readAvailability(orgId, personIds.slice(at, at + chunkSize), span.firstSunday, span.lastSunday, allowedSubsidiaryIds))
    }

    type TitleClaim = { key: string; display: string; hours: string }
    type Cell = {
      demand: string[]
      hard: string[]
      soft: string[]
      capacity: string[]
      unknown: AvailabilityFigure[]
      titles: TitleClaim[]
      demandLineIds: string[]
      opportunityIds: string[]
      assignmentIds: string[]
      capacityPersonIds: string[]
      absenceRowIds: string[]
      holidayDates: string[]
    }
    const newCell = (): Cell => ({
      demand: [], hard: [], soft: [], capacity: [], unknown: [], titles: [],
      demandLineIds: [], opportunityIds: [], assignmentIds: [],
      capacityPersonIds: [],
      absenceRowIds: [], holidayDates: [],
    })
    const cells = new Map<string, Cell>()
    const cellFor = (departmentId: string, weekStart: string): Cell => {
      const key = `${departmentId} ${weekStart}`
      let cell = cells.get(key)
      if (!cell) {
        cell = newCell()
        cells.set(key, cell)
      }
      return cell
    }

    for (const line of demand) {
      if (line.basis !== 'manual' && line.basis !== 'pipeline') continue
      if (cmp(line.weightedHours, '0') <= 0) continue
      const cell = cellFor(line.departmentId, line.weekStart)
      cell.demand.push(line.weightedHours)
      cell.demandLineIds.push(line.lineId)
      if (line.opportunityId) cell.opportunityIds.push(line.opportunityId)
      cell.titles.push({ key: normalizeTitle(line.jobTitle), display: line.jobTitle, hours: line.weightedHours })
    }

    for (const row of assignments) {
      let departmentId: string
      if (row.employee_party_id !== null) {
        const holder = people.get(row.employee_party_id)
        const name = holder?.displayName || row.person_name || row.employee_party_id
        const depts = uniqueSorted([...(holder?.departments ?? [])])
        if (depts.length !== 1 || !depts[0]) {
          throw new ResourcingRefusal(
            422,
            'busy_season_person_department_ambiguous',
            `${name} has ${depts.length === 0 ? 'no' : 'several'} active departments, so their planned hours cannot be placed in one practice`,
            `give ${name} exactly one active department on their employee record (Entities → Employees)`,
          )
        }
        const title = holder?.titles.entries().next().value
        if (!holder || holder.titles.size !== 1 || !title) {
          throw new ResourcingRefusal(
            422,
            'busy_season_person_title_missing',
            `${name} has no usable job title, so their planned hours cannot be suggested as a request`,
            `add a job title to ${name}'s employee role (Entities → Employees)`,
          )
        }
        departmentId = depts[0]!
        const [key, display] = title
        cellFor(departmentId, row.week_start).titles.push({ key, display, hours: row.planned_hours })
      } else {
        const stored = row.job_title ?? ''
        const key = normalizeTitle(stored)
        let holders = 0
        const holderDepts = new Set<string>()
        for (const person of people.values()) {
          if (!person.titles.has(key)) continue
          holders += 1
          for (const dept of person.departments) holderDepts.add(dept)
        }
        const depts = uniqueSorted([...holderDepts])
        if (holders === 0) {
          throw new ResourcingRefusal(
            422,
            'busy_season_generic_title_unknown',
            `no active in-scope employee holds job title ${stored}, so its generic hours cannot be placed in one practice`,
            `use an existing job title, or add it to an employee's role`,
            'jobTitle',
          )
        }
        if (depts.length !== 1 || !depts[0]) {
          throw new ResourcingRefusal(
            422,
            'busy_season_generic_title_ambiguous',
            `job title ${stored} is held across several departments, so its generic hours cannot be placed in one practice`,
            `give every active ${stored} holder one department on their employee record (Entities → Employees)`,
            'jobTitle',
          )
        }
        departmentId = depts[0]!
        if (key) cellFor(departmentId, row.week_start).titles.push({ key, display: stored, hours: row.planned_hours })
      }
      const cell = cellFor(departmentId, row.week_start)
      if (row.booking === 'soft') cell.soft.push(row.planned_hours)
      else cell.hard.push(row.planned_hours)
      cell.assignmentIds.push(row.id)
    }

    for (const figure of figures) {
      const person = people.get(figure.employeePartyId)
      const name = person?.displayName || figure.employeePartyId
      const depts = uniqueSorted([...(person?.departments ?? [])])
      if (depts.length !== 1 || !depts[0]) {
        throw new ResourcingRefusal(
          422,
          'busy_season_capacity_department_ambiguous',
          `${name} has ${depts.length === 0 ? 'no' : 'several'} active departments, so their capacity cannot be placed in one practice`,
          `give ${name} exactly one active department on their employee record (Entities → Employees)`,
        )
      }
      const cell = cellFor(depts[0]!, figure.weekStart)
      if (figure.netCapacity === null) {
        cell.unknown.push(figure)
      } else {
        cell.capacity.push(figure.netCapacity)
        cell.capacityPersonIds.push(figure.employeePartyId)
      }
      for (const id of figure.timeOff.absenceRowIds) cell.absenceRowIds.push(id)
      for (const holiday of figure.holidays.dates) cell.holidayDates.push(holiday.date)
    }

    for (const [key, cell] of cells) {
      const splitAt = key.lastIndexOf(' ')
      const departmentId = key.slice(0, splitAt)
      const weekStart = key.slice(splitAt + 1)
      const sumOf = (hours: string[]): string => hours.reduce((total, value) => add(total, value), '0.0000')
      const demandHours = sumOf(cell.demand)
      const planHardHours = sumOf(cell.hard)
      const planSoftHours = sumOf(cell.soft)
      const planHours = add(planHardHours, planSoftHours)
      const loadHours = add(add(demandHours, planHardHours), planSoftHours)
      if (cmp(loadHours, '0') > 0 && cell.unknown.length > 0) {
        assertPlannableCapacity(cell.unknown[0]!)
      }
      const capacityHours = sumOf(cell.capacity)
      const gapHours = add(loadHours, neg(capacityHours))
      if (cmp(gapHours, '0') <= 0) continue
      const departmentName = departments.get(departmentId) ?? departmentId
      const byTitle = new Map<string, { display: string; hours: string[] }>()
      for (const claim of cell.titles) {
        if (!claim.key) continue
        let entry = byTitle.get(claim.key)
        if (!entry) {
          entry = { display: claim.display, hours: [] }
          byTitle.set(claim.key, entry)
        }
        entry.hours.push(claim.hours)
      }
      let suggestedJobTitle: string | null = null
      let bestHours: string | null = null
      let bestKey = ''
      for (const [titleKey, entry] of byTitle) {
        const total = sumOf(entry.hours)
        if (bestHours === null || cmp(total, bestHours) > 0 || (cmp(total, bestHours) === 0 && titleKey < bestKey)) {
          bestHours = total
          bestKey = titleKey
          suggestedJobTitle = entry.display
        }
      }
      if (suggestedJobTitle === null) {
        const line = cell.demandLineIds[0]
        throw new ResourcingRefusal(
          422,
          'busy_season_demand_title_missing',
          `a demand row in ${departmentName} for week ${weekStart}${line ? ` (line ${line})` : ''} carries no job title, so its hours cannot be suggested as a request`,
          'give every demand line a job title on the demand list',
        )
      }
      gaps.push({
        departmentId,
        departmentName,
        weekStart,
        demandHours,
        planHardHours,
        planSoftHours,
        planHours,
        capacityHours,
        gapHours,
        suggestedJobTitle,
        evidence: {
          demandLineIds: uniqueSorted(cell.demandLineIds),
          opportunityIds: uniqueSorted(cell.opportunityIds),
          assignmentIds: uniqueSorted(cell.assignmentIds),
          capacityPersonIds: uniqueSorted(cell.capacityPersonIds),
          absenceRowIds: uniqueSorted(cell.absenceRowIds),
          holidayDates: uniqueSorted(cell.holidayDates),
        },
      })
    }
  }

  gaps.sort((a, b) =>
    a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1
      : a.departmentName < b.departmentName ? -1 : a.departmentName > b.departmentName ? 1
        : a.departmentId < b.departmentId ? -1 : 1,
  )
  return { seasonYear, spans, gaps, projects }
}
