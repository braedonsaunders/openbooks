import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { createPayRun, PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Pay runs collection.
 *
 *  GET  → runs joined to their documents (number/status ride the document).
 *  POST → mint the next run for a schedule (period derives from the schedule's
 *         anchor when not supplied). Creation is a payroll.run action — the
 *         run itself is a posting document and posts through the standard
 *         document actions route.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET() {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const runs = (await db.execute(sql`
    select r.document_id, d.document_number, d.status as document_status, d.currency,
           r.pay_schedule_id, s.name as schedule_name,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_status,
           r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
      from pay_runs r
      join documents d on d.id = r.document_id
      left join pay_schedules s on s.id = r.pay_schedule_id
     where r.org_id = ${gate.user.orgId}
     order by r.pay_date desc, d.document_number desc`)) as unknown as { rows: Record<string, unknown>[] }
  return NextResponse.json({ runs: runs.rows })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  if (!isUuid(body.payScheduleId)) return NextResponse.json({ error: 'payScheduleId required' }, { status: 422 })
  for (const key of ['periodStart', 'periodEnd', 'payDate'] as const) {
    if (body[key] != null && !DATE_RE.test(String(body[key]))) {
      return NextResponse.json({ error: `invalid ${key} (YYYY-MM-DD)` }, { status: 422 })
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
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
