import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { createPayRun, PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardSubsidiaryScope, subsidiaryScopeAllows } from '../../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Pay runs collection.
 *
 *  GET  → runs joined to their documents (number/status ride the document).
 *         Subsidiary-restricted callers see only runs whose legal entity is
 *         inside their scope, using the same fail-closed filter as the other
 *         subsidiary-aware list queries.
 *  POST → mint the next run for a schedule (period derives from the schedule's
 *         anchor when not supplied). Creation is a payroll.run action — the
 *         run itself is a posting document and posts through the standard
 *         document actions route.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET() {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const runs = (await db.execute<Record<string, unknown>>(sql`
    select r.document_id, d.document_number, d.status as document_status, d.currency,
           r.pay_schedule_id, s.name as schedule_name,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_status,
           r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      left join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
     where r.org_id = ${gate.user.orgId}${subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)}
     order by r.pay_date desc, d.document_number desc`))
  return NextResponse.json({ runs: runs.rows })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (!isUuid(body.payScheduleId)) return NextResponse.json({ error: 'payScheduleId required' }, { status: 422 })
  for (const key of ['periodStart', 'periodEnd', 'payDate'] as const) {
    if (body[key] != null && !DATE_RE.test(String(body[key]))) {
      return NextResponse.json({ error: `invalid ${key} (YYYY-MM-DD)` }, { status: 422 })
    }
  }
  const runType = body.runType ?? 'regular'
  if (!['regular', 'bonus', 'termination'].includes(runType)) {
    return NextResponse.json({ error: 'invalid runType' }, { status: 422 })
  }
  // A final pay run pays out and clears every accrued bank, so it must name
  // the employees it pays; the engine refuses an unscoped one outright.
  const employeePartyIds: string[] = Array.isArray(body.employeePartyIds)
    ? body.employeePartyIds.map((id: unknown) => String(id))
    : []
  if (employeePartyIds.some((id) => !isUuid(id))) {
    return NextResponse.json({ error: 'invalid employeePartyIds' }, { status: 422 })
  }
  if (runType === 'termination' && employeePartyIds.length === 0) {
    return NextResponse.json(
      { error: 'a final pay run must name the employees it pays' },
      { status: 422 },
    )
  }
  // A run belongs to the schedule's legal entity. Resolve that entity before
  // entering createPayRun so a restricted caller cannot mint another
  // subsidiary's run (a termination run can clear every accrued bank). An
  // org-wide schedule follows the engine's root-subsidiary convention. Missing
  // schedules, roots, and out-of-scope entities all fail closed with the same
  // not-found response and therefore disclose no payroll metadata.
  if (gate.allowedSubsidiaryIds) {
    const schedule = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select subsidiary_id as "subsidiaryId"
        from pay_schedules
       where org_id = ${gate.user.orgId} and id = ${body.payScheduleId} and is_active`)).rows[0]
    const runSubsidiaryId = schedule?.subsidiaryId
      ?? (schedule
        ? (await db.execute<{ id: string }>(sql`
            select id
              from subsidiaries
             where org_id = ${gate.user.orgId} and parent_id is null and is_active
             order by created_at
             limit 1`)).rows[0]?.id ?? null
        : null)
    const denied = guardSubsidiaryScope(gate, runSubsidiaryId)
    if (denied) return denied

    // Termination (and any explicitly named run) also carries employee
    // payroll data. Parties with no subsidiary are org-wide shared identities,
    // matching the party-list semantics; unknown ids fail closed because the
    // number of visible rows must equal the number requested.
    const namedEmployees = [...new Set(employeePartyIds)]
    if (namedEmployees.length > 0) {
      const people = await db.execute<{ subsidiaryId: string | null }>(sql`
        select subsidiary_id as "subsidiaryId"
          from parties
         where org_id = ${gate.user.orgId}
           and id = any(${`{${namedEmployees.join(',')}}`}::uuid[])`)
      const visible = people.rows.filter((person) =>
        subsidiaryScopeAllows(gate.allowedSubsidiaryIds, person.subsidiaryId, { orgWideNull: true }))
      if (visible.length !== namedEmployees.length) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }
  try {
    const result = await createPayRun({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      payScheduleId: body.payScheduleId,
      periodStart: body.periodStart ?? undefined,
      periodEnd: body.periodEnd ?? undefined,
      payDate: body.payDate ?? undefined,
      runType,
      employeePartyIds,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
