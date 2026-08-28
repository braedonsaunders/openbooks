import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { runRecordFlows } from '@openbooks/engine/src/flows/run.ts'
import { TIMESHEET_WEEK_SUBJECT_KIND } from '@openbooks/engine/src/flows/timesheet-weeks-adapter.ts'
import {
  ensureTimesheetWeek,
  isIsoDate,
  loadWeek,
  pinTimesheetEmployee,
  setTimesheetWeekStatus,
  weekStart,
  weekWindow,
} from '../_lib'

export const runtime = 'nodejs'

class SubmissionFlowError extends Error {
  constructor() {
    super('timesheet submission workflow failed')
    this.name = 'SubmissionFlowError'
  }
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

interface Body {
  employee?: string
  week?: string
}

/** POST { employee, week } → move the week's draft entries to submitted. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'timeTracking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const orgId = user.orgId

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const ownedEmployee = await pinTimesheetEmployee(orgId, body.employee, gate.allowedSubsidiaryIds)
  if (!ownedEmployee) return bad('Employee not found')
  const week = weekStart(body.week)
  const days = weekWindow(week)

  let flow: Awaited<ReturnType<typeof runRecordFlows>>
  try {
    // 'rejected' resubmits as well as 'draft'. A rejection is a request to fix
    // and send back, so excluding it left a bounced week with no route forward —
    // the employee could edit it but never submit it again. The approver's note
    // is cleared on resubmission so a stale reason cannot outlive the fix.
    //
    // Keep the entry update, week header, and flow dispatch in one transaction.
    // Flow runs and their durable outbox effects participate in the ambient
    // tenant transaction, so a failed dispatch rolls back every submission
    // write instead of compensating with a second, failure-prone update.
    flow = await withOrgTransaction(orgId, async () => {
      await db.execute(sql`
        update time_entries
           set status = 'submitted', rejection_reason = null,
               updated_at = now(), updated_by = ${user.id}
         where org_id = ${orgId}
           and employee_party_id = ${ownedEmployee}
           and worked_on >= ${days[0]} and worked_on <= ${days[6]}
           and status in ('draft', 'rejected')
      `)

      // Hand the submission to Flows, exactly as documents do. A flow that
      // raises approval gates OWNS the week: it stays submitted until the
      // gates resolve, and the engine calls the release handler with the
      // outcome. When no flow matches, the built-in approve endpoint remains
      // the route — flows ADD routing (who, quorum, escalation), they do not
      // become mandatory.
      const header = await ensureTimesheetWeek(
        orgId,
        ownedEmployee,
        week,
        user.id,
        gate.allowedSubsidiaryIds,
      )
      await setTimesheetWeekStatus(
        orgId,
        ownedEmployee,
        week,
        'submitted',
        user.id,
        null,
        gate.allowedSubsidiaryIds,
      )

      const dispatched = await runRecordFlows(
        { kind: 'on_submit' },
        TIMESHEET_WEEK_SUBJECT_KIND,
        header.id,
        { orgId, userId: user.id },
      )
      // Fail closed: an on_submit flow that errored (e.g. resolved to zero
      // approvers) must not leave the week looking routed when nobody was
      // asked. Throwing reaches withOrgTransaction's rollback boundary.
      if (dispatched.failed) throw new SubmissionFlowError()
      return dispatched
    })
  } catch (error) {
    if (error instanceof SubmissionFlowError) {
      return NextResponse.json(
        { error: 'The approval workflow for this timesheet could not start. Nothing was submitted.' },
        { status: 409 },
      )
    }
    throw error
  }

  const payload = await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds)
  return NextResponse.json({
    ...payload,
    gated: flow.gatesCreated > 0,
    runId: flow.runs.find((run) => run.status === 'waiting')?.runId ?? null,
  })
}
