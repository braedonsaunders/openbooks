import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json"
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/iso-date.ts'
import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'
import {
  createRetroPayRun,
  proposeRetroPay,
} from '@openbooks/engine/src/payroll/retro-store.ts'
import '../../../../lib/feature-gates';
import '../../../../lib/list-params';
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { guardPayrollEmployees } from '../subsidiary-scope'
import { notFound } from "@/lib/api/responses";

const retroInput = z.object({
  payScheduleId: z.string().uuid(),
  payDate: z.string().refine(isIsoCalendarDate, 'payDate must be a real calendar date (YYYY-MM-DD)'),
  employeePartyIds: z.array(z.string().uuid()).optional(),
  excludeSourcePayRunDocumentIds: z.array(z.string().uuid()).optional(),
})
const requestBodySchema = z.discriminatedUnion('action', [
  retroInput.extend({ action: z.literal('propose') }),
  retroInput.extend({ action: z.literal('create') }),
])



export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Retroactive pay: detect → quantify → review → pay.
 *
 * `POST` with `{ action: 'propose' }` writes NOTHING. It re-runs each affected
 * committed period through the pay run's own calculation
 * (engine/src/payroll/retro-store.ts) and differences the earnings, so it is
 * expensive and unsafe to cache — which is exactly why it is a POST and not a
 * GET. It requires `payroll.run` rather than `payroll.read` for the same
 * reason: it is real payroll computation, not a query.
 *
 * `POST` with `{ action: 'create' }` builds the retro pay run and files the
 * settlements that are its evidence — `payroll.run`.
 *
 * Every rule (what counts as a trigger, what a difference is, what is payable,
 * how "exactly once" is enforced) lives in the engine. This route only
 * translates HTTP, so no second caller can reach a different answer.
 */

/**
 * Retro detection is employee-driven, so an omitted employee list must be
 * narrowed before it reaches the engine. Otherwise the engine quite correctly
 * detects every employee in the schedule, which would let a restricted caller
 * create or inspect another subsidiary's retro settlements.
 */
async function scopedRetroEmployees(
  gate: Parameters<typeof guardPayrollEmployees>[0],
  payScheduleId: string,
  requested: string[] | undefined,
): Promise<string[] | NextResponse> {
  if (gate.allowedSubsidiaryIds === null) return requested ?? []

  const root = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${gate.user.orgId} and parent_id is null and is_active
     order by created_at limit 1`)).rows[0]?.id ?? null
  const schedule = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select coalesce(s.subsidiary_id, ${root}) as "subsidiaryId"
      from pay_schedules s
     where s.org_id = ${gate.user.orgId} and s.id = ${payScheduleId} and s.is_active`)).rows[0]
  const deniedSchedule = guardSubsidiaryScope(gate, schedule?.subsidiaryId)
  if (deniedSchedule) return deniedSchedule

  // The detector walks every committed source run for this schedule. Prove
  // that population is inside scope before invoking it; otherwise a malformed
  // run whose document was re-homed could leak its source period through a
  // candidate even when the employee itself is visible.
  const sourceRuns = await db.execute<{ subsidiaryId: string | null }>(sql`
    select coalesce(d.subsidiary_id, ${root}) as "subsidiaryId"
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${gate.user.orgId}
       and r.pay_schedule_id = ${payScheduleId}
       and r.run_status = 'committed'
       and r.run_type <> 'retro'`)
  for (const sourceRun of sourceRuns.rows) {
    const denied = guardSubsidiaryScope(gate, sourceRun.subsidiaryId)
    if (denied) return denied
  }

  if (requested) {
    const deniedEmployees = await guardPayrollEmployees(gate, requested)
    if (deniedEmployees) return deniedEmployees as NextResponse
    return requested
  }

  const rows = await db.execute<{ id: string }>(sql`
    select distinct s.employee_party_id as id
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${gate.user.orgId}
       and r.pay_schedule_id = ${payScheduleId}
       and r.run_status = 'committed'
       and r.run_type <> 'retro'
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)}`)
  const ids = rows.rows.map((row) => row.id)
  // An empty scoped population must never be represented as `undefined`: the
  // engine treats undefined/empty as "all employees". There is no retro data
  // to expose when no allowed employee has a committed source run.
  return ids.length > 0 ? ids : notFound("record")
}

async function guardExcludedSourceRuns(
  gate: Parameters<typeof guardPayrollEmployees>[0],
  payScheduleId: string,
  sourceIds: string[] | undefined,
): Promise<NextResponse | null> {
  if (gate.allowedSubsidiaryIds === null || !sourceIds || sourceIds.length === 0) return null
  const rows = await db.execute<{ id: string }>(sql`
    select r.document_id as id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${gate.user.orgId}
       and r.pay_schedule_id = ${payScheduleId}
       and r.document_id in (${sql.join(sourceIds.map((id) => sql`${id}`), sql`, `)})
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)}`)
  return rows.rows.length === new Set(sourceIds).size
    ? null
    : notFound("record")
}

export const POST = defineRoute({
  permission: 'payroll.run',
  feature: 'payroll',
  handler: async ({ request: req, authz: gate }) => {

    const parsedBody = await parseJsonBody(req, requestBodySchema, { status: 422 })
    if (!parsedBody.ok) return parsedBody.response
    const body = parsedBody.data

    // An explicitly empty list is the workspace's default state (no
    // exclusions checked, no employee filter applied) and means the same as
    // an absent key. uuidList already folds [] to undefined; the checks below
    // must not mistake that fold for a malformed value, or every UI propose
    // that excludes nothing is refused with 422.
    const requestedEmployees = body.employeePartyIds?.length ? body.employeePartyIds : undefined
    const employeePartyIds = await scopedRetroEmployees(
      gate,
      body.payScheduleId,
      requestedEmployees,
    )
    if (employeePartyIds instanceof NextResponse) return employeePartyIds

    const excludedSourcePayRunDocumentIds = body.excludeSourcePayRunDocumentIds?.length
      ? body.excludeSourcePayRunDocumentIds
      : undefined
    const deniedExcluded = await guardExcludedSourceRuns(
      gate,
      body.payScheduleId,
      excludedSourcePayRunDocumentIds,
    )
    if (deniedExcluded) return deniedExcluded

    const input = {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      payScheduleId: body.payScheduleId,
      payDate: body.payDate,
      employeePartyIds,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    }

    try {
      if (body.action === 'create') {
        const result = await createRetroPayRun({
          ...input,
          excludeSourcePayRunDocumentIds: excludedSourcePayRunDocumentIds,
        })
        return NextResponse.json(result)
      }
      return NextResponse.json(await proposeRetroPay(input))
    } catch (error) {
      // A refusal is the product working: nothing to pay, a decrease that is an
      // overpayment recovery, a period in another statutory year. It reaches the
      // operator as its own sentence, never as a 500.
      if (error instanceof PayrollError) {
        return apiErrorResponse(error, { safeStatus: 422 })
      }
      throw error
    }

  },
})
