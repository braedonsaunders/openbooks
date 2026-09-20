import { lockAndCheckPayrollRunPopulation } from "@openbooks/engine/src/payroll/scope.ts";
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { acknowledgePayRunRefusals, commitPayRun, previewPayRunGl } from "@openbooks/engine/src/payroll/run-commit.ts";
import { calculatePayRun } from "@openbooks/engine/src/payroll/run-calculation.ts";
import { discardPayRun } from "@openbooks/engine/src/payroll/run-lifecycle.ts";
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import { recordPayRunPayment } from '@openbooks/engine/src/payroll/payment.ts'
import { assertPayRunNotStale } from '@openbooks/engine/src/payroll/readiness.ts'
import {
  assertPayRunApprovalReleased, payRunApprovalState,
} from '@openbooks/engine/src/payroll/approval.ts'
import { submitForApproval } from '@openbooks/engine/src/flows/index.ts'
import { emailRunStubs } from '../../../../../lib/payroll-outputs'
import { assemblePayRunEvidence } from '../../../../../lib/payroll-evidence'
import { canonicalAdjustmentHours, mutatePayRunAdjustment } from '@openbooks/engine/src/payroll/run-adjustments.ts'
import { storedHolidayEligibilityForRun } from '@openbooks/engine/src/payroll/holiday-attestations.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { decimalNullRefusal, suppliedValue } from '../../../../../lib/payroll-decimal-refusal'

export const dynamic = 'force-dynamic'

/** Statutory-holiday attestation facts, mirroring the engine's input shape. */
interface HolidayEligibilityFacts {
  paidOnCommission?: boolean
  absentWithoutConsent?: boolean
}

/**
 * Parse the optional `holidayEligibility` map for calculate/dry-run.
 * One pass builds the clean map AND names the first malformed shape, so the
 * accept/refuse set cannot drift between a checker and a builder.
 * `undefined` input yields an empty clean map — absence of attestations is
 * the engine's fail-closed default, not a request error. Every refusal names
 * the offending key or fact, the value received, and a remedy that exists.
 */
function parseHolidayEligibility(
  value: unknown,
): { ok: true; map: Record<string, HolidayEligibilityFacts> } | { ok: false; refusal: string } {
  if (value === undefined) return { ok: true, map: {} }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      refusal: `holidayEligibility must be a map of employee ids to attestation facts — got "${suppliedValue(value)}"; pass an object keyed by employee id, or omit it`,
    }
  }
  const clean: Record<string, HolidayEligibilityFacts> = {}
  for (const [employeeId, facts] of Object.entries(value as Record<string, unknown>)) {
    if (!isUuid(employeeId)) {
      return {
        ok: false,
        refusal: `holidayEligibility key "${suppliedValue(employeeId)}" is not an employee id — fix that key and try again`,
      }
    }
    if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
      return {
        ok: false,
        refusal: `holidayEligibility["${employeeId}"] must be a map of attestation facts — got "${suppliedValue(facts)}"; pass paidOnCommission and absentWithoutConsent as true or false, or omit the entry`,
      }
    }
    const entry: HolidayEligibilityFacts = {}
    for (const [key, fact] of Object.entries(facts as Record<string, unknown>)) {
      if (key !== 'paidOnCommission' && key !== 'absentWithoutConsent') {
        return {
          ok: false,
          refusal: `holidayEligibility["${employeeId}"] has unknown fact "${suppliedValue(key)}" — only paidOnCommission and absentWithoutConsent exist; fix the name and try again`,
        }
      }
      if (typeof fact !== 'boolean') {
        return {
          ok: false,
          refusal: `holidayEligibility["${employeeId}"].${key} must be true or false — got "${suppliedValue(fact)}"; pass a boolean or omit the fact`,
        }
      }
      entry[key] = fact
    }
    clean[employeeId] = entry
  }
  return { ok: true, map: clean }
}

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

  return db.transaction(async (tx) => {
    const runs = (await tx.execute<Record<string, unknown>>(sql`
      select r.document_id, d.document_number, d.status as document_status, d.currency,
             d.subsidiary_id as "subsidiaryId",
             r.pay_schedule_id, s.name as schedule_name,
             r.period_start::text as period_start, r.period_end::text as period_end,
             r.pay_date::text as pay_date, r.tax_year, r.run_status,
             r.gross_total, r.net_total, r.employer_cost_total, r.employee_count,
             r.calculation_errors, r.refusal_acknowledgement
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        left join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${id}
         for share of r,d`))
    const run = runs.rows[0]
    if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const denied = guardSubsidiaryScope(gate, run.subsidiaryId as string | null | undefined)
    if (denied) return denied

    try {
      await lockAndCheckPayrollRunPopulation(tx, orgId, id, gate.allowedSubsidiaryIds)
    } catch (error) {
      if (error instanceof PayrollError) return NextResponse.json({ error: 'not found' }, { status: 404 })
      throw error
    }

    const [stubs, lines] = (await Promise.all([
      tx.execute<Record<string, unknown>>(sql`
        select st.id, st.employee_party_id, p.display_name as employee_name, st.province,
               st.gross, st.pensionable_earnings, st.insurable_earnings, st.net_pay,
               st.employer_cost, st.vacation_accrued, st.federal_claim, st.provincial_claim,
               st.factors
          from pay_stubs st
          join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
         where st.org_id = ${orgId} and st.pay_run_document_id = ${id}
         order by p.display_name`),
      tx.execute<Record<string, unknown>>(sql`
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
      tx.execute<Record<string, unknown>>(sql`
        select a.id, a.employee_party_id, a.adjustment_type, a.component_id, a.amount, a.hours,
               a.replace_component, a.note, p.display_name as employee_name, c.name as component_name
          from pay_run_adjustments a
          join parties p on p.id = a.employee_party_id and p.org_id = a.org_id
          left join pay_components c on c.id = a.component_id and c.org_id = a.org_id
         where a.org_id = ${orgId} and a.pay_run_document_id = ${id}
         order by p.display_name, a.created_at`),
      tx.execute<Record<string, unknown>>(sql`
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
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Resolve and gate the owning document before parsing or dispatching any
  // action. Every mutation below eventually reaches a shared engine service;
  // keeping this check ahead of that dispatch prevents an out-of-scope run
  // from being calculated, edited, approved, committed, or paid by id.
  const owned = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select d.subsidiary_id as "subsidiaryId"
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${gate.user.orgId} and r.document_id = ${id}`)).rows[0]
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
  if (denied) return denied
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  // Employer attestations for statutory-holiday rules that read them (the
  // last-and-first-shift absence assertion, commission-pay status). The
  // engine fails closed when a declaring rule's fact is missing, and neither
  // the wizard nor this route could supply it — so any run spanning a paid
  // holiday in a declaring jurisdiction was incalculable. Keys are employee
  // ids; unknown ids are refused rather than silently unattested.
  const parsedEligibility = parseHolidayEligibility(body.holidayEligibility)
  if (!parsedEligibility.ok) {
    return NextResponse.json({ error: parsedEligibility.refusal }, { status: 422 })
  }
  const holidayEligibility = parsedEligibility.map
  try {
    if (body.action === 'calculate' || body.action === 'dry-run') {
      // Stored attestation facts merge UNDER the per-request map: what the
      // operator filed on the run (absence assertions) and on the employee
      // (commission status) fills what this request omits. The request wins
      // everywhere it answers, and an answer missing from both stays missing
      // — the engine fails closed on it by name.
      const mergedEligibility = await storedHolidayEligibilityForRun(db, {
        orgId: gate.user.orgId, documentId: id,
        perRequest: holidayEligibility,
      })
      const result = await calculatePayRun({
        orgId: gate.user.orgId, documentId: id, actorId: gate.user.id,
        dryRun: body.action === 'dry-run',
        holidayEligibility: mergedEligibility,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
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
      // Every malformed shape refuses by name. One collapsed 'invalid
      // adjustment' over nine predicates meant a single bad id among two
      // thousand employees was undiagnosable — the refusal below names the
      // offending value AND its index. Same accept/refuse sets, split causes.
      if (typeof componentId !== 'string') {
        return NextResponse.json({ error: `componentId must be a pay component id — got "${suppliedValue(componentId)}"; choose one from this run's adjustableComponents` }, { status: 422 })
      }
      if (!isUuid(componentId)) {
        return NextResponse.json({ error: `componentId "${componentId}" is not a pay component id — choose one from this run's adjustableComponents` }, { status: 422 })
      }
      if (!Array.isArray(body.employeePartyIds)) {
        return NextResponse.json({ error: `employeePartyIds must be a list of employee ids — got "${suppliedValue(body.employeePartyIds)}"; pass the employees to adjust as a list` }, { status: 422 })
      }
      const employees = body.employeePartyIds
      if (employees.length === 0) {
        return NextResponse.json({ error: 'bulk-adjustment needs at least one employee — employeePartyIds is empty; pass the employees to adjust as a list' }, { status: 422 })
      }
      if (employees.length > 2000) {
        return NextResponse.json({ error: `bulk-adjustment accepts at most 2000 employees at once — got ${employees.length}; split the batch and try again` }, { status: 422 })
      }
      const badIndex = employees.findIndex((v: unknown) => typeof v !== 'string' || !isUuid(v))
      if (badIndex !== -1) {
        return NextResponse.json({ error: `employeePartyIds[${badIndex}] "${suppliedValue(employees[badIndex])}" is not an employee id — fix that entry and try again` }, { status: 422 })
      }
      const amountRaw = canonicalDecimal(amount, 4)
      if (amountRaw === null) {
        return NextResponse.json({ error: decimalNullRefusal('amount', 'an amount', amount, 4) }, { status: 422 })
      }
      if (note != null && typeof note !== 'string') {
        return NextResponse.json({ error: `note must be text — got "${suppliedValue(note)}"; pass the note as text or omit it` }, { status: 422 })
      }
      if (typeof note === 'string' && note.length > 500) {
        return NextResponse.json({ error: `note is limited to 500 characters — got ${note.length}; shorten it and try again` }, { status: 422 })
      }
      if (replaceComponent != null && typeof replaceComponent !== 'boolean') {
        return NextResponse.json({ error: `replaceComponent must be true or false — got "${suppliedValue(replaceComponent)}"; pass a boolean or omit it` }, { status: 422 })
      }
      const canonicalAmount = normalizeMoney(amountRaw)
      await withOrgTransaction(gate.user.orgId, async () => {
        for (const employeePartyId of employees as string[]) {
          await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            mutation: { action: 'add', employeePartyId, componentId, amount: canonicalAmount, replaceComponent: replaceComponent ?? undefined, note },
          })
        }
      })
      return NextResponse.json({ ok: true, applied: employees.length })
    }
    if (body.action === 'preview-gl') {
      // Read-only: the exact legs commit would write, for the wizard's review
      // step. payroll.read suffices conceptually, but the wizard drives it and
      // the route is already gated payroll.run.
      const result = await previewPayRunGl(gate.user.orgId, id, gate.allowedSubsidiaryIds)
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === 'add-adjustment') {
      const { employeePartyId, componentId, amount, hours, note, replaceComponent } = body
      const amountRaw = canonicalDecimal(amount, 4)
      // Hours persist into numeric(12,2): canonicalize at that scale, never
      // through the 4dp money normalizer (its padding fails the engine gate
      // for every hours value). The engine re-validates before persisting.
      // Every malformed shape refuses by name below — same accept/refuse set
      // as the old collapsed 'invalid
      // adjustment', split causes.
      let hoursRaw: string | null = null
      if (hours != null && hours !== '') {
        hoursRaw = canonicalAdjustmentHours(hours)
        if (hoursRaw === null) {
          const hoursExact = canonicalDecimal(hours, 2)
          if (hoursExact !== null && hoursExact.startsWith('-')) {
            return NextResponse.json({ error: `hours must not be negative — got "${suppliedValue(hours)}"; pass zero or more hours, or omit hours` }, { status: 422 })
          }
          if (hoursExact !== null && hoursExact.replace(/^[+]/, '').split('.')[0]!.replace(/^0+/, '').length > 10) {
            return NextResponse.json({ error: `hours is out of range — at most 10 whole digits fit; got "${suppliedValue(hours)}"; enter fewer hours and try again` }, { status: 422 })
          }
          return NextResponse.json({ error: decimalNullRefusal('hours', 'a number of hours', hours, 2) }, { status: 422 })
        }
      }
      if (typeof employeePartyId !== 'string') {
        return NextResponse.json({ error: `employeePartyId must be an employee id — got "${suppliedValue(employeePartyId)}"; pass the employee as an employee id` }, { status: 422 })
      }
      if (!isUuid(employeePartyId)) {
        return NextResponse.json({ error: `employeePartyId "${employeePartyId}" is not an employee id — fix the id and try again` }, { status: 422 })
      }
      if (typeof componentId !== 'string') {
        return NextResponse.json({ error: `componentId must be a pay component id — got "${suppliedValue(componentId)}"; choose one from this run's adjustableComponents` }, { status: 422 })
      }
      if (!isUuid(componentId)) {
        return NextResponse.json({ error: `componentId "${componentId}" is not a pay component id — choose one from this run's adjustableComponents` }, { status: 422 })
      }
      if (amountRaw === null) {
        return NextResponse.json({ error: decimalNullRefusal('amount', 'an amount', amount, 4) }, { status: 422 })
      }
      if (note != null && typeof note !== 'string') {
        return NextResponse.json({ error: `note must be text — got "${suppliedValue(note)}"; pass the note as text or omit it` }, { status: 422 })
      }
      if (typeof note === 'string' && note.length > 500) {
        return NextResponse.json({ error: `note is limited to 500 characters — got ${note.length}; shorten it and try again` }, { status: 422 })
      }
      if (replaceComponent != null && typeof replaceComponent !== 'boolean') {
        return NextResponse.json({ error: `replaceComponent must be true or false — got "${suppliedValue(replaceComponent)}"; pass a boolean or omit it` }, { status: 422 })
      }
      await mutatePayRunAdjustment({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        mutation: { action: 'add', employeePartyId, componentId, amount: normalizeMoney(amountRaw), hours: hoursRaw, replaceComponent: replaceComponent ?? undefined, note },
      })
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'delete-adjustment') {
      if (typeof body.adjustmentId !== 'string') {
        return NextResponse.json({ error: `adjustmentId must be a pay adjustment id — got "${suppliedValue(body.adjustmentId)}"; pass the adjustment to delete as an id` }, { status: 422 })
      }
      if (!isUuid(body.adjustmentId)) {
        return NextResponse.json({ error: `adjustmentId "${body.adjustmentId}" is not a pay adjustment id — fix the id and try again` }, { status: 422 })
      }
      await mutatePayRunAdjustment({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        mutation: { action: 'delete', adjustmentId: body.adjustmentId },
      })
      return NextResponse.json({ ok: true })
    }
    // Bulk scope: set the run's included employees in one call. Everyone on
    // the roster who is NOT in `employeePartyIds` gets an exclusion row; those
    // in it have theirs removed. Changed members go through the same audited
    // helper one at a time — no second write path — and the whole diff is one
    // transaction, so a partial scope can never be committed.
    if (body.action === 'set-scope') {
      // Every malformed shape refuses by name. One collapsed 'invalid
      // scope' over two lists, a limit and two entry checks meant a single bad id on
      // a 2000-employee roster was undiagnosable — the refusal below names
      // the offending value AND its index. Same accept/refuse set, split
      // causes: an empty included list still excludes everyone, and an empty
      // roster is still a no-op.
      if (!Array.isArray(body.employeePartyIds)) {
        return NextResponse.json({ error: `employeePartyIds must be a list of employee ids — got "${suppliedValue(body.employeePartyIds)}"; pass the employees to include as a list` }, { status: 422 })
      }
      if (!Array.isArray(body.rosterPartyIds)) {
        return NextResponse.json({ error: `rosterPartyIds must be a list of employee ids — got "${suppliedValue(body.rosterPartyIds)}"; pass the run roster as a list` }, { status: 422 })
      }
      const included = body.employeePartyIds
      const roster = body.rosterPartyIds
      if (roster.length > 2000) {
        return NextResponse.json({ error: `set-scope accepts at most 2000 roster employees at once — got ${roster.length}; split the roster and try again` }, { status: 422 })
      }
      const badIncluded = included.findIndex((v: unknown) => typeof v !== 'string' || !isUuid(v))
      if (badIncluded !== -1) {
        return NextResponse.json({ error: `employeePartyIds[${badIncluded}] "${suppliedValue(included[badIncluded])}" is not an employee id — fix that entry and try again` }, { status: 422 })
      }
      const badRoster = roster.findIndex((v: unknown) => typeof v !== 'string' || !isUuid(v))
      if (badRoster !== -1) {
        return NextResponse.json({ error: `rosterPartyIds[${badRoster}] "${suppliedValue(roster[badRoster])}" is not an employee id — fix that entry and try again` }, { status: 422 })
      }
      const keep = new Set(included as string[])
      await withOrgTransaction(gate.user.orgId, async () => {
        // DIFF against the current scope, never replay the roster. Every
        // mutatePayRunAdjustment call re-validates its member, so looping the
        // whole roster re-checks people whose scope is not changing — and one
        // of them (a deactivated employee, an edited profile) rolls back the
        // entire transaction. A member already in scope and staying, or
        // already out and staying out, is not being changed and is skipped;
        // only actual additions and removals are validated. That closes this
        // trap for every predicate, not just the active-member one.
        const excludedRows = (await db.execute<{ employee_party_id: string }>(sql`
          select employee_party_id from pay_run_adjustments
           where org_id = ${gate.user.orgId} and pay_run_document_id = ${id}
             and adjustment_type = 'exclude'
        `))
        const excluded = new Set(excludedRows.rows.map((row) => row.employee_party_id))
        for (const employeePartyId of roster as string[]) {
          const wanted = keep.has(employeePartyId) ? 'include' : 'exclude'
          const current = excluded.has(employeePartyId) ? 'exclude' : 'include'
          if (wanted === current) continue
          await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            mutation: { action: wanted, employeePartyId },
          })
        }
      })
      return NextResponse.json({ ok: true, included: keep.size, excluded: roster.length - keep.size })
    }
    if (body.action === 'exclude-employee' || body.action === 'include-employee') {
      if (typeof body.employeePartyId !== 'string') {
        return NextResponse.json({ error: `employeePartyId must be an employee id — got "${suppliedValue(body.employeePartyId)}"; pass the employee as an employee id` }, { status: 422 })
      }
      if (!isUuid(body.employeePartyId)) {
        return NextResponse.json({ error: `employeePartyId "${body.employeePartyId}" is not an employee id — fix the id and try again` }, { status: 422 })
      }
      await mutatePayRunAdjustment({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        mutation: {
          action: body.action === 'exclude-employee' ? 'exclude' : 'include',
          employeePartyId: body.employeePartyId,
        },
      })
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'email-stubs') {
      const result = await emailRunStubs(gate.user.orgId, id, gate.allowedSubsidiaryIds)
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === 'record-payment') {
      if (typeof body.bankAccountId !== 'string' || !isUuid(body.bankAccountId)) return NextResponse.json({ error: 'choose a bank account' }, { status: 422 })
      const result = await recordPayRunPayment({
        orgId: gate.user.orgId, actorId: gate.user.id, documentId: id,
        bankAccountId: body.bankAccountId,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    // Submit for approval: assemble the evidence package (payroll journal +
    // register + GL preview) onto the run, then route it through Flows. A
    // tenant with no pay_run flow gets `gated: false` and nothing is parked.
    if (body.action === 'submit-approval') {
      const evidence = await assemblePayRunEvidence(gate.user.orgId, gate.user.id, id, gate.allowedSubsidiaryIds)
      const submission = await submitForApproval('pay_run', id, gate.user.id)
      if (submission.flowError) {
        return NextResponse.json({ error: submission.flowError }, { status: 422 })
      }
      return NextResponse.json({ ok: true, evidence, gated: submission.gated })
    }
    if (body.action === 'approval-state') {
      return NextResponse.json({ ok: true, ...(await payRunApprovalState(gate.user.orgId, id)) })
    }
    // Record an explicit decision to commit while in-scope employees are
    // refused. Taken against the run's CURRENT stored refusal set server-side
    // — never a caller-supplied list — so the acknowledgement necessarily
    // names exactly who is being left out, with the refusal text verbatim.
    if (body.action === 'acknowledge-refusals') {
      const acknowledgement = await acknowledgePayRunRefusals({
        orgId: gate.user.orgId, documentId: id, actorId: gate.user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
      return NextResponse.json({ ok: true, acknowledgement })
    }
    if (body.action === 'commit') {
      // Money must not move before approval: commit materializes the GL
      // projection and claims the period's time entries. Nor may it move on
      // figures the operator edited past: the wizard's stale banner is only
      // the rendering of the engine check — this boundary enforces it, so a
      // stale tab or a scripted call cannot commit a calculation its inputs
      // outlived. (The wizard reads the same `payRunStaleness`; one source of
      // truth, two consumers — render and refuse.)
      await assertPayRunNotStale(gate.user.orgId, id, db, gate.allowedSubsidiaryIds)
      await assertPayRunApprovalReleased(gate.user.orgId, id)
      const result = await commitPayRun({ orgId: gate.user.orgId, documentId: id, actorId: gate.user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds })
      return NextResponse.json({ ok: true, ...result })
    }
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}

/**
 * Discard a draft pay run.
 *
 * The boundary lives in the engine (`discardPayRun`): only an uncommitted
 * run on a draft document with no GL lines and no payment goes. A committed
 * or posted run is refused there with the void remedy — discarding is not a
 * quiet void. Missing and out-of-scope runs answer the same 404.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const owned = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select d.subsidiary_id as "subsidiaryId"
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${gate.user.orgId} and r.document_id = ${id}`)).rows[0]
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
  if (denied) return denied
  try {
    const result = await discardPayRun({
      orgId: gate.user.orgId, documentId: id, actorId: gate.user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof PayrollError) {
      const status = e.message === 'pay run not found' ? 404 : 422
      return NextResponse.json({ error: e.message }, { status })
    }
    throw e
  }
}
