import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { amendLockedWeek, amendTimeEntry } from '../../../../lib/time-amendment'
import {
  isIsoDate,
  loadWeek,
  pinTimesheetEmployee,
  pinTimesheetEntryEmployee,
  weekStart,
} from '../_lib'

export const runtime = 'nodejs'

/**
 * POST { entryId } or { employee, week } → create offsetting draft entries
 * that amend consumed originals. Used when reopen is refused because the
 * hours are already invoiced, paid, costed or ticketed.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.reopen', 'timeTracking')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { entryId?: string; employee?: string; week?: string }
  try {
    if (body.entryId) {
      if (!isUuid(body.entryId)) {
        return NextResponse.json({ error: 'Invalid entry' }, { status: 422 })
      }
      const sourceEmployee = await pinTimesheetEntryEmployee(
        gate.user.orgId,
        body.entryId,
        gate.allowedSubsidiaryIds,
      )
      if (!sourceEmployee) {
        return NextResponse.json({ error: 'Entry not found' }, { status: 422 })
      }
      const result = await amendTimeEntry(gate.user.orgId, gate.user.id, body.entryId)
      return NextResponse.json(result, { status: 201 })
    }
    if (!body.employee || !isUuid(body.employee)) {
      return NextResponse.json({ error: 'Invalid employee' }, { status: 422 })
    }
    if (!body.week || !isIsoDate(body.week)) {
      return NextResponse.json({ error: 'Invalid week' }, { status: 422 })
    }
    const ownedEmployee = await pinTimesheetEmployee(
      gate.user.orgId,
      body.employee,
      gate.allowedSubsidiaryIds,
    )
    if (!ownedEmployee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 422 })
    }
    const week = weekStart(body.week)
    const result = await amendLockedWeek(gate.user.orgId, gate.user.id, ownedEmployee, week)
    const payload = await loadWeek(
      gate.user.orgId,
      ownedEmployee,
      week,
      gate.allowedSubsidiaryIds,
    )
    return NextResponse.json({ ...payload, ...result }, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'could not amend' }, { status: 422 })
  }
}
