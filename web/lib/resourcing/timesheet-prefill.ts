import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { projects, resAssignments } from '@openbooks/schema'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isFeatureEnabled } from '../features'
import { subsidiaryVisibleFilter } from '../subsidiaries'

export type PlannedRow = {
  projectId: string
  itemId: string | null
  isBillable: boolean
  plannedHours: string
}

type ExistingRowKey = {
  projectId: string | null
  itemId: string | null
  isBillable: boolean
}

/** Match assignments to visible project choices without changing captured rows. */
export function plannedTimesheetRows(
  planned: readonly PlannedRow[],
  existingRows: readonly ExistingRowKey[],
  projectOptionIds: ReadonlySet<string>,
): { rows: PlannedRow[]; badgeOnExisting: number[] } {
  const rows: PlannedRow[] = []
  const badgeOnExisting = new Set<number>()
  for (const booking of planned) {
    if (!projectOptionIds.has(booking.projectId)) continue
    const index = existingRows.findIndex((row) =>
      row.projectId === booking.projectId && row.itemId === booking.itemId && row.isBillable === booking.isBillable,
    )
    if (index >= 0) badgeOnExisting.add(index)
    else rows.push(booking)
  }
  return { rows, badgeOnExisting: [...badgeOnExisting] }
}

/** Load firm bookings for one employee-week that the caller can see. */
export async function loadPlannedWeek(
  orgId: string,
  employeePartyId: string,
  sundayIso: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<PlannedRow[]> {
  if (!(await isFeatureEnabled(orgId, 'resourcing'))) return []
  return db.select({
    projectId: resAssignments.projectId,
    itemId: resAssignments.billItemId,
    isBillable: resAssignments.isBillable,
    plannedHours: resAssignments.plannedHours,
  })
    .from(resAssignments)
    .innerJoin(projects, and(
      eq(projects.orgId, resAssignments.orgId),
      eq(projects.id, resAssignments.projectId),
    ))
    .where(sql`${and(
      eq(resAssignments.orgId, orgId),
      eq(resAssignments.employeePartyId, employeePartyId),
      eq(resAssignments.weekStart, sundayIso),
      eq(resAssignments.booking, 'hard'),
      eq(resAssignments.state, 'active'),
    )}${subsidiaryVisibleFilter(sql`${projects.subsidiaryId}`, allowedSubsidiaryIds)}`)
    .orderBy(asc(resAssignments.projectId), asc(resAssignments.id))
}
