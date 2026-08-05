import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { calculatePayRun, commitPayRun, PayrollError, previewPayRunGl } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * One pay run.
 *
 *  GET  → run header + every stub (employee, statutory splits, T4127 factors)
 *         and its component lines. Wage data — never served below payroll.read.
 *  POST → { action: 'calculate' | 'commit' } drives the engine pipeline;
 *         posting rides the standard /api/documents/actions route.
 */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const orgId = gate.user.orgId

  const runs = (await db.execute(sql`
    select r.document_id, d.document_number, d.status as document_status, d.currency,
           r.pay_schedule_id, s.name as schedule_name,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_status,
           r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
      from pay_runs r
      join documents d on d.id = r.document_id
      left join pay_schedules s on s.id = r.pay_schedule_id
     where r.org_id = ${orgId} and r.document_id = ${id}`)) as unknown as { rows: Record<string, unknown>[] }
  const run = runs.rows[0]
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const [stubs, lines] = (await Promise.all([
    db.execute(sql`
      select st.id, st.employee_party_id, p.display_name as employee_name, st.province,
             st.gross, st.pensionable_earnings, st.insurable_earnings, st.net_pay,
             st.employer_cost, st.vacation_accrued, st.federal_claim, st.provincial_claim,
             st.factors
        from pay_stubs st
        join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
       where st.org_id = ${orgId} and st.pay_run_document_id = ${id}
       order by p.display_name`),
    db.execute(sql`
      select l.stub_id, l.kind, l.description, l.hours, l.rate, l.amount, l.sequence,
             c.code as component_code, pr.name as project_name, dep.name as department_name
        from pay_stub_lines l
        join pay_stubs st on st.id = l.stub_id
        left join pay_components c on c.id = l.component_id
        left join projects pr on pr.id = l.project_id
        left join departments dep on dep.id = l.department_id
       where l.org_id = ${orgId} and st.pay_run_document_id = ${id}
       order by l.stub_id, l.sequence`),
  ])) as unknown as [{ rows: Record<string, unknown>[] }, { rows: Record<string, unknown>[] }]

  const linesByStub = new Map<string, Record<string, unknown>[]>()
  for (const line of lines.rows) {
    const stubId = String(line.stub_id)
    const list = linesByStub.get(stubId)
    if (list) list.push(line)
    else linesByStub.set(stubId, [line])
  }
  return NextResponse.json({
    run,
    stubs: stubs.rows.map((stub) => ({ ...stub, lines: linesByStub.get(String(stub.id)) ?? [] })),
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  try {
    if (body.action === 'calculate') {
      const result = await calculatePayRun({ orgId: gate.user.orgId, documentId: id, actorId: gate.user.id })
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === 'preview-gl') {
      // Read-only: the exact legs commit would write, for the wizard's review
      // step. payroll.read suffices conceptually, but the wizard drives it and
      // the route is already gated payroll.run.
      const result = await previewPayRunGl(gate.user.orgId, id)
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === 'commit') {
      const result = await commitPayRun({ orgId: gate.user.orgId, documentId: id, actorId: gate.user.id })
      return NextResponse.json({ ok: true, ...result })
    }
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
