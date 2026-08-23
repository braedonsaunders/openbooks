import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { calculatePayRun, commitPayRun, PayrollError, previewPayRunGl } from '@openbooks/engine/src/payroll-run.ts'
import { recordPayRunPayment } from '@openbooks/engine/src/payroll-payment.ts'
import {
  assertPayRunApprovalReleased, payRunApprovalState,
} from '@openbooks/engine/src/payroll-approval.ts'
import { submitForApproval } from '@openbooks/engine/src/flows/index.ts'
import { emailRunStubs } from '../../../../../lib/payroll-outputs'
import { assemblePayRunEvidence } from '../../../../../lib/payroll-evidence'
import { mutatePayRunAdjustment } from '@openbooks/engine/src/payroll-run-adjustments.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { canonicalDecimal, compareDecimal } from '../../../../../lib/exact-decimal'

export const dynamic = 'force-dynamic'

/**
 * One pay run.
 *
 *  GET  → run header + every stub (employee, statutory splits, T4127 factors)
 *         and its component lines. Wage data — never served below payroll.read.
 *  POST → { action: 'calculate' | 'submit-approval' | 'commit' } drives the
 *         engine pipeline; posting rides the standard /api/documents/actions
 *         route. Commit and the bank file fail closed while a Flows approval
 *         is outstanding; posting is already gated by the document lifecycle.
 */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const orgId = gate.user.orgId

  const runs = (await db.execute<Record<string, unknown>>(sql`
    select r.document_id, d.document_number, d.status as document_status, d.currency,
           r.pay_schedule_id, s.name as schedule_name,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_status,
           r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      left join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${id}`))
  const run = runs.rows[0]
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const [stubs, lines] = (await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select st.id, st.employee_party_id, p.display_name as employee_name, st.province,
             st.gross, st.pensionable_earnings, st.insurable_earnings, st.net_pay,
             st.employer_cost, st.vacation_accrued, st.federal_claim, st.provincial_claim,
             st.factors
        from pay_stubs st
        join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
       where st.org_id = ${orgId} and st.pay_run_document_id = ${id}
       order by p.display_name`),
    db.execute<Record<string, unknown>>(sql`
      select l.stub_id, l.kind, l.description, l.hours, l.rate, l.amount, l.sequence,
             c.code as component_code, pr.name as project_name, dep.name as department_name
        from pay_stub_lines l
        join pay_stubs st on st.id = l.stub_id and st.org_id = l.org_id
        left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
        left join projects pr on pr.id = l.project_id and pr.org_id = l.org_id
        left join departments dep on dep.id = l.department_id and dep.org_id = l.org_id
       where l.org_id = ${orgId} and st.pay_run_document_id = ${id}
       order by l.stub_id, l.sequence`),
  ]))

  const linesByStub = new Map<string, Record<string, unknown>[]>()
  for (const line of lines.rows) {
    const stubId = String(line.stub_id)
    const list = linesByStub.get(stubId)
    if (list) list.push(line)
    else linesByStub.set(stubId, [line])
  }
  const [adjustments, adjustableComponents] = (await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select a.id, a.employee_party_id, a.adjustment_type, a.component_id, a.amount, a.hours,
             a.replace_component, a.note, p.display_name as employee_name, c.name as component_name
        from pay_run_adjustments a
        join parties p on p.id = a.employee_party_id and p.org_id = a.org_id
        left join pay_components c on c.id = a.component_id and c.org_id = a.org_id
       where a.org_id = ${orgId} and a.pay_run_document_id = ${id}
       order by p.display_name, a.created_at`),
    db.execute<Record<string, unknown>>(sql`
      select id, code, name, kind from pay_components
       where org_id = ${orgId} and is_active
         and (system_key is null or system_key in ('base_pay','overtime','bonus','vacation_payout'))
       order by sequence, code`),
  ]))

  return NextResponse.json({
    run,
    stubs: stubs.rows.map((stub) => ({ ...stub, lines: linesByStub.get(String(stub.id)) ?? [] })),
    adjustments: adjustments.rows,
    adjustableComponents: adjustableComponents.rows,
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  try {
    if (body.action === 'calculate' || body.action === 'dry-run') {
      const result = await calculatePayRun({
        orgId: gate.user.orgId, documentId: id, actorId: gate.user.id,
        dryRun: body.action === 'dry-run',
      })
      return NextResponse.json({ ok: true, ...result })
    }
    // Apply one component amount across many employees in one pass — the
    // review step's bulk edit. Each employee still gets its own audited
    // adjustment row through the same helper as a single edit, and the whole
    // batch shares one transaction: a mid-loop failure rolls back every
    // adjustment instead of committing a partial set.
    if (body.action === 'bulk-adjustment') {
      const { componentId, amount, note, replaceComponent } = body
      const employees = Array.isArray(body.employeePartyIds) ? body.employeePartyIds : []
      const amountRaw = canonicalDecimal(amount, 4)
      if (
        !isUuid(componentId) || employees.length === 0 || employees.length > 2000 ||
        !employees.every((v: unknown) => typeof v === 'string' && isUuid(v)) ||
        amountRaw === null ||
        (note != null && (typeof note !== 'string' || note.length > 500)) ||
        (replaceComponent != null && typeof replaceComponent !== 'boolean')
      ) {
        return NextResponse.json({ error: 'invalid adjustment' }, { status: 422 })
      }
      const canonicalAmount = normalizeMoney(amountRaw)
      await withOrgTransaction(gate.user.orgId, async () => {
        for (const employeePartyId of employees as string[]) {
          await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            mutation: { action: 'add', employeePartyId, componentId, amount: canonicalAmount, replaceComponent, note },
          })
        }
      })
      return NextResponse.json({ ok: true, applied: employees.length })
    }
    if (body.action === 'preview-gl') {
      // Read-only: the exact legs commit would write, for the wizard's review
      // step. payroll.read suffices conceptually, but the wizard drives it and
      // the route is already gated payroll.run.
      const result = await previewPayRunGl(gate.user.orgId, id)
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === 'add-adjustment') {
      const { employeePartyId, componentId, amount, hours, note, replaceComponent } = body
      const amountRaw = canonicalDecimal(amount, 4)
      let hoursRaw: string | null
      if (hours == null || hours === '') {
        hoursRaw = null
      } else {
        const exact = canonicalDecimal(hours, 4)
        if (exact === null) return NextResponse.json({ error: 'invalid adjustment' }, { status: 422 })
        try {
          hoursRaw = normalizeMoney(exact)
        } catch {
          return NextResponse.json({ error: 'invalid adjustment' }, { status: 422 })
        }
      }
      if (
        !isUuid(employeePartyId) || !isUuid(componentId) ||
        amountRaw === null ||
        (hoursRaw !== null && compareDecimal(hoursRaw, '0') < 0) ||
        (note != null && (typeof note !== 'string' || note.length > 500)) ||
        (replaceComponent != null && typeof replaceComponent !== 'boolean')
      ) {
        return NextResponse.json({ error: 'invalid adjustment' }, { status: 422 })
      }
      await mutatePayRunAdjustment({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        mutation: { action: 'add', employeePartyId, componentId, amount: normalizeMoney(amountRaw), hours: hoursRaw, replaceComponent, note },
      })
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'delete-adjustment') {
      if (!isUuid(body.adjustmentId)) return NextResponse.json({ error: 'invalid adjustment' }, { status: 422 })
      await mutatePayRunAdjustment({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        mutation: { action: 'delete', adjustmentId: body.adjustmentId },
      })
      return NextResponse.json({ ok: true })
    }
    // Bulk scope: set the run's included employees in one call. Everyone on
    // the roster who is NOT in `employeePartyIds` gets an exclusion row; those
    // in it have theirs removed. One mutation per employee through the same
    // audited helper — no second write path — and the whole roster pass is one
    // transaction, so a partial scope can never be committed.
    if (body.action === 'set-scope') {
      const included = Array.isArray(body.employeePartyIds) ? body.employeePartyIds : null
      const roster = Array.isArray(body.rosterPartyIds) ? body.rosterPartyIds : null
      const uuidish = (v: unknown) => typeof v === 'string' && isUuid(v)
      if (!included || !roster || roster.length > 2000
        || !included.every(uuidish) || !roster.every(uuidish)) {
        return NextResponse.json({ error: 'invalid scope' }, { status: 422 })
      }
      const keep = new Set(included as string[])
      await withOrgTransaction(gate.user.orgId, async () => {
        for (const employeePartyId of roster as string[]) {
          await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            mutation: {
              action: keep.has(employeePartyId) ? 'include' : 'exclude',
              employeePartyId,
            },
          })
        }
      })
      return NextResponse.json({ ok: true, included: keep.size, excluded: roster.length - keep.size })
    }
    if (body.action === 'exclude-employee' || body.action === 'include-employee') {
      if (!isUuid(body.employeePartyId)) return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
      await mutatePayRunAdjustment({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        mutation: {
          action: body.action === 'exclude-employee' ? 'exclude' : 'include',
          employeePartyId: body.employeePartyId,
        },
      })
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'email-stubs') {
      const result = await emailRunStubs(gate.user.orgId, id)
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === 'record-payment') {
      if (!isUuid(body.bankAccountId)) return NextResponse.json({ error: 'choose a bank account' }, { status: 422 })
      const result = await recordPayRunPayment({
        orgId: gate.user.orgId, actorId: gate.user.id, documentId: id,
        bankAccountId: body.bankAccountId,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    // Submit for approval: assemble the evidence package (payroll journal +
    // register + GL preview) onto the run, then route it through Flows. A
    // tenant with no pay_run flow gets `gated: false` and nothing is parked.
    if (body.action === 'submit-approval') {
      const evidence = await assemblePayRunEvidence(gate.user.orgId, gate.user.id, id)
      const submission = await submitForApproval('pay_run', id, gate.user.id)
      if (submission.flowError) {
        return NextResponse.json({ error: submission.flowError }, { status: 422 })
      }
      return NextResponse.json({ ok: true, evidence, gated: submission.gated })
    }
    if (body.action === 'approval-state') {
      return NextResponse.json({ ok: true, ...(await payRunApprovalState(gate.user.orgId, id)) })
    }
    if (body.action === 'commit') {
      // Money must not move before approval: commit materializes the GL
      // projection and claims the period's time entries.
      await assertPayRunApprovalReleased(gate.user.orgId, id)
      const result = await commitPayRun({ orgId: gate.user.orgId, documentId: id, actorId: gate.user.id })
      return NextResponse.json({ ok: true, ...result })
    }
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
