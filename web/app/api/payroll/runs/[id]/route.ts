import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/error-response";
import { lockAndCheckPayrollRunPopulation } from "@openbooks/engine/payroll/scope";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  acknowledgePayRunRefusals,
  commitPayRun,
  previewPayRunGl,
} from "@openbooks/engine/payroll/run-commit";
import { calculatePayRun } from "@openbooks/engine/payroll/run-calculation";
import { attributePayRunEntity, discardPayRun } from "@openbooks/engine/payroll/run-lifecycle";
import {
  documentKindPermissions,
  postPermission,
} from "@openbooks/engine/records/document-kind-permissions";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { recordPayRunPayment } from "@openbooks/engine/payroll/payment";
import { assertPayRunNotStale } from "@openbooks/engine/payroll/readiness";
import { resolvePayrollProfileEmploymentLinks } from "@openbooks/engine/payroll/profile-employment";
import {
  assertPayRunApprovalReleased,
  payRunApprovalState,
  recalculateStaleApprovedPayRun,
} from "@openbooks/engine/payroll/approval";
import { rendererStatusResponse } from "../../../../../lib/api/pdf-renderer";
import { emailRunStubs } from "../../../../../lib/payroll-outputs";
import { submitPayRunForApproval } from "../../../../../lib/payroll/run-approval";
import {
  canonicalAdjustmentHours,
  mutatePayRunAdjustment,
  recordPayRunHolidayHours,
  payRunBulkAdjustmentId,
  PayRunAdjustmentIdempotencyConflict,
} from "@openbooks/engine/payroll/run-adjustments";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { can, guardSubsidiaryScope } from "../../../../../lib/authz";
import { guardPayrollEmployees } from "../../subsidiary-scope";
import { isUuid } from "../../../../../lib/list-params";
import { canonicalDecimal } from "../../../../../lib/exact-decimal";
import { decimalNullRefusal, suppliedValue } from "../../../../../lib/payroll-decimal-refusal";
import { notFound } from "@/lib/api/responses";
import { parseBankCashInputEvidence } from "@openbooks/engine/payroll/run-bank-cash-evidence";
import { parseDeclaredVacationAccrualEvidence } from "@openbooks/engine/payroll/run-vacation-accrual-input";

const payrollRunUuid = (field: string, subject: string, remedy: string, malformedRemedy = remedy) =>
  z
    .string({
      error: (issue) =>
        `${field} must be ${subject} — got "${suppliedValue(issue.input)}"; ${remedy}`,
    })
    .refine(isUuid, {
      error: (issue) =>
        `${field} "${suppliedValue(issue.input)}" is not ${subject} — ${malformedRemedy}`,
    });
const payrollRunMoney = z.string().superRefine((value, context) => {
  if (canonicalDecimal(value, 4) === null) {
    context.addIssue({
      code: "custom",
      message: decimalNullRefusal("amount", "an amount", value, 4),
    });
  }
});
const actionBody = <A extends string>(action: A) => ({ action: z.literal(action) });
// The handler validates each entry with its index so an operator can repair a
// specific row in a long payroll roster; the boundary validates list shape.
const employeeIds = (remedy: string) =>
  z.array(z.json(), {
    error: (issue) =>
      `employeePartyIds must be a list of employee ids — got "${suppliedValue(issue.input)}"; ${remedy}`,
  });
const rosterIds = z.array(z.json(), {
  error: (issue) =>
    `rosterPartyIds must be a list of employee ids — got "${suppliedValue(issue.input)}"; pass the run roster as a list`,
});
const requestBodySchema = z.preprocess(
  (value, context) => {
    if (value && typeof value === "object" && Object.hasOwn(value, "holidayEligibility")) {
      context.addIssue({
        code: "custom",
        message:
          "holidayEligibility is not a calculation input — file holiday assertions on the pay run and standing commission or occupation facts on the employee, then recalculate",
      });
      return z.NEVER;
    }
    return value;
  },
  z.discriminatedUnion("action", [
    z.strictObject({ ...actionBody("calculate") }),
    z.strictObject({ ...actionBody("dry-run") }),
    z.strictObject({
      ...actionBody("bulk-adjustment"),
      componentId: payrollRunUuid(
        "componentId",
        "a pay component id",
        "choose one from this run's adjustableComponents",
      ),
      amount: payrollRunMoney,
      employeePartyIds: employeeIds("pass the employees to adjust as a list"),
      note: z.json().optional(),
      replaceComponent: z.json().optional(),
    }),
    z.strictObject({ ...actionBody("preview-gl") }),
    z.strictObject({
      ...actionBody("add-adjustment"),
      employeePartyId: payrollRunUuid(
        "employeePartyId",
        "an employee id",
        "pass the employee as an employee id",
        "fix the id and try again",
      ),
      componentId: payrollRunUuid(
        "componentId",
        "a pay component id",
        "choose one from this run's adjustableComponents",
      ),
      amount: payrollRunMoney,
      hours: z.string().nullable().optional(),
      earnedFrom: z.string().nullable().optional(),
      earnedTo: z.string().nullable().optional(),
      note: z.json().optional(),
      replaceComponent: z.json().optional(),
    }),
    z.strictObject({
      ...actionBody("override-income-tax"),
      employeePartyId: payrollRunUuid(
        "employeePartyId",
        "an employee id",
        "select the employee whose cheque withholding is being recorded",
      ),
      amount: payrollRunMoney,
      reason: z.string().trim().min(1).max(500),
      sourceReference: z.string().trim().min(1).max(300),
    }),
    z.strictObject({
      ...actionBody("bank-cash-input"),
      employeePartyId: payrollRunUuid(
        "employeePartyId",
        "an employee id",
        "select the employee whose bank cash line is being recorded",
      ),
      componentId: payrollRunUuid(
        "componentId",
        "a pay component id",
        "choose the configured bank payout or deposit component",
      ),
      hours: z.string().min(1).max(32),
      amount: z.string().max(80).optional(),
      rate: z.string().max(80).optional(),
      outsideBankAmount: z.string().max(80).optional(),
      reason: z.string().trim().min(1).max(500),
      sourceReference: z.string().trim().min(1).max(300),
    }),
    z.strictObject({
      ...actionBody("employer-levy-adjustment"),
      employeePartyId: payrollRunUuid(
        "employeePartyId",
        "an employee id",
        "select the employee whose issued employer levy is being recorded",
      ),
      programKey: z.enum(["ca_eht", "ca_wcb"]),
      workerCompGroupId: payrollRunUuid(
        "workerCompGroupId",
        "a worker compensation group id",
        "select the dated worker compensation group",
      )
        .nullable()
        .optional(),
      amount: payrollRunMoney,
      sourceKey: z.string().trim().min(1).max(200),
      reason: z.string().trim().min(1).max(500),
      sourceReference: z.string().trim().min(1).max(300),
    }),
    z.strictObject({
      ...actionBody("declared-vacation-accrual"),
      employeePartyId: payrollRunUuid(
        "employeePartyId",
        "an employee id",
        "select the employee whose vacation accrual is being recorded",
      ),
      amount: payrollRunMoney,
      reason: z.string().trim().min(1).max(500),
      sourceReference: z.string().trim().min(1).max(300),
    }),
    z.strictObject({
      ...actionBody("record-holiday-hours"),
      employeePartyId: payrollRunUuid(
        "employeePartyId",
        "an employee id",
        "select the employee whose paid holiday hours are being recorded",
      ),
      hours: z.string(),
      earnedOn: z.string().optional(),
      reason: z.string().trim().min(1).max(500),
      note: z.string().max(500).optional(),
    }),
    z.strictObject({
      ...actionBody("delete-adjustment"),
      adjustmentId: payrollRunUuid(
        "adjustmentId",
        "a pay adjustment id",
        "pass the adjustment to delete as an id",
        "fix the id and try again",
      ),
    }),
    z.strictObject({
      ...actionBody("set-scope"),
      employeePartyIds: employeeIds("pass the employees to include as a list"),
      rosterPartyIds: rosterIds,
    }),
    z.strictObject({
      ...actionBody("exclude-employee"),
      employeePartyId: payrollRunUuid(
        "employeePartyId",
        "an employee id",
        "pass the employee as an employee id",
        "fix the id and try again",
      ),
    }),
    z.strictObject({
      ...actionBody("include-employee"),
      employeePartyId: payrollRunUuid(
        "employeePartyId",
        "an employee id",
        "pass the employee as an employee id",
        "fix the id and try again",
      ),
    }),
    z.strictObject({ ...actionBody("email-stubs") }),
    z.strictObject({
      ...actionBody("record-payment"),
      bankAccountId: payrollRunUuid(
        "bankAccountId",
        "a bank account id",
        "choose a bank account",
      ).optional(),
      settlementClearingAccountId: payrollRunUuid(
        "settlementClearingAccountId",
        "an account id",
        "choose the designated settlement clearing account",
      ).optional(),
      paidOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "paidOn must be a calendar date (YYYY-MM-DD)")
        .optional(),
    }),
    z.strictObject({ ...actionBody("submit-approval") }),
    z.strictObject({ ...actionBody("recalculate-approved") }),
    z.strictObject({ ...actionBody("approval-state") }),
    z.strictObject({ ...actionBody("acknowledge-refusals") }),
    z.strictObject({
      ...actionBody("resolve-employment-links"),
      employeePartyIds: employeeIds("pass the employees to link as a list").optional(),
    }),
    z.strictObject({
      ...actionBody("attribute-entity"),
      subsidiaryId: payrollRunUuid(
        "subsidiaryId",
        "a subsidiary id",
        "choose a subsidiary to attribute this run to",
      ),
    }),
    z.strictObject({ ...actionBody("commit") }),
  ]),
);

export const dynamic = "force-dynamic";

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

export const GET = defineRoute({
  permission: "payroll.read",
  feature: "payroll",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const orgId = gate.user.orgId;

    return db.transaction(async (tx) => {
      const runs = await tx.execute<Record<string, unknown>>(
        sql`
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
           for share of r,d`,
        "objects",
      );
      const run = runs[0];
      if (!run) return notFound("record");
      const denied = guardSubsidiaryScope(gate, run.subsidiaryId as string | null | undefined);
      if (denied) return denied;

      try {
        await lockAndCheckPayrollRunPopulation(tx, orgId, id, gate.allowedSubsidiaryIds);
      } catch (error) {
        if (error instanceof PayrollError) return notFound("record");
        throw error;
      }

      // Sequential reads: this transaction holds one pg client, so reading
      // both result sets at once queues concurrent queries on it.
      const stubs = await tx.execute<Record<string, unknown>>(
        sql`
          select st.id, st.employee_party_id, p.display_name as employee_name, st.province,
                 st.gross, st.pensionable_earnings, st.insurable_earnings, st.net_pay,
                 st.employer_cost, st.vacation_accrued, st.federal_claim, st.provincial_claim,
                 st.factors
            from pay_stubs st
            join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
           where st.org_id = ${orgId} and st.pay_run_document_id = ${id}
           order by p.display_name`,
        "objects",
      );
      const lines = await tx.execute<Record<string, unknown>>(
        sql`
          select l.stub_id, l.kind, l.description, l.hours, l.rate, l.amount, l.sequence,
                 c.code as component_code, pr.name as project_name, dep.name as department_name
            from pay_stub_lines l
            join pay_stubs st on st.id = l.stub_id and st.org_id = l.org_id
            left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
            left join projects pr on pr.id = l.project_id and pr.org_id = l.org_id
            left join departments dep on dep.id = l.department_id and dep.org_id = l.org_id
           where l.org_id = ${orgId} and st.pay_run_document_id = ${id}
           order by l.stub_id, l.sequence`,
        "objects",
      );

      const linesByStub = new Map<string, Record<string, unknown>[]>();
      for (const line of lines) {
        const stubId = String(line.stub_id);
        const list = linesByStub.get(stubId);
        if (list) list.push(line);
        else linesByStub.set(stubId, [line]);
      }
      const adjustments = await tx.execute<Record<string, unknown>>(
        sql`
          select a.id, a.employee_party_id, a.adjustment_type, a.component_id, a.amount, a.hours, a.earned_from::text, a.earned_to::text,
                 a.replace_component, a.note, p.display_name as employee_name, c.name as component_name
            from pay_run_adjustments a
            join parties p on p.id = a.employee_party_id and p.org_id = a.org_id
            left join pay_components c on c.id = a.component_id and c.org_id = a.org_id
           where a.org_id = ${orgId} and a.pay_run_document_id = ${id}
           order by p.display_name, a.created_at`,
        "objects",
      );
      const adjustableComponents = await tx.execute<Record<string, unknown>>(
        sql`
          select component.id, component.code, component.name, component.kind,
                 exists(select 1 from entitlement_plans vacation_plan
                   join pay_components accrual_component
                     on accrual_component.org_id=vacation_plan.org_id
                    and accrual_component.id=vacation_plan.accrual_component_id
                    and accrual_component.is_active and accrual_component.kind='employer_contribution'
                  where vacation_plan.org_id=component.org_id and vacation_plan.system_key='vacation'
                    and vacation_plan.is_active and vacation_plan.unit='money' and vacation_plan.direction='accrue') as declared_vacation_accrual_enabled,
                 exists(select 1 from entitlement_plans plan
                   where plan.org_id=component.org_id and plan.is_active and plan.unit in ('hours','money')
                     and component.kind='earning' and component.payment_kind='cash'
                     and (plan.payout_component_id=component.id or plan.deposit_component_id=component.id)) as bank_cash_component
            from pay_components component
           where component.org_id = ${orgId} and component.is_active
             and (component.system_key is null or component.system_key in ('base_pay','overtime','allowance','bonus','vacation_payout')
               or exists(select 1 from entitlement_plans plan
                 where plan.org_id=component.org_id and plan.is_active and plan.unit in ('hours','money')
                   and component.kind='earning' and component.payment_kind='cash'
                   and (plan.payout_component_id=component.id or plan.deposit_component_id=component.id)))
           order by component.sequence, component.code`,
        "objects",
      );

      return NextResponse.json({
        run,
        stubs: stubs.map((stub) => ({ ...stub, lines: linesByStub.get(String(stub.id)) ?? [] })),
        adjustments: adjustments.map((row) => {
          const evidence = parseBankCashInputEvidence(
            typeof row.note === "string" ? row.note : null,
          );
          const declaredVacation = parseDeclaredVacationAccrualEvidence(
            typeof row.note === "string" ? row.note : null,
          );
          return evidence
            ? {
                ...row,
                note: `${evidence.reason} · ${evidence.sourceReference}${evidence.rate ? ` · ${evidence.rate}/h` : ""}${evidence.outsideBankAmount ? ` · ${evidence.outsideBankAmount} paid outside bank` : ""}`,
              }
            : declaredVacation
              ? { ...row, note: `${declaredVacation.reason} · ${declaredVacation.sourceReference}` }
              : row;
        }),
        adjustableComponents,
      });
    });
  },
});

const authorizedRunRequests = new WeakSet<Request>();

export const POST = defineRoute({
  authorize: async ({ params, request }) => {
    const gate = await guardFeaturePermission("payroll.run", "payroll");
    if (gate instanceof NextResponse) return gate;
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !isUuid(id)) return notFound("record");
    const owned = (
      await db.execute<{ subsidiaryId: string | null }>(
        sql`
      select d.subsidiary_id as "subsidiaryId"
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${gate.user.orgId} and r.document_id = ${id}`,
        "objects",
      )
    )[0];
    if (!owned) return notFound("record");
    const denied = guardSubsidiaryScope(gate, owned.subsidiaryId);
    if (denied) return denied;
    authorizedRunRequests.add(request);
    return gate;
  },
  feature: "payroll",
  body: requestBodySchema,
  invalidBodyStatus: 422,
  params: z.object({ id: z.string() }),
  invalidParamsNotFound: "record",
  handler: async ({ request: req, authz: gate, params: routeParams, body }) => {
    const { id } = routeParams;
    if (!authorizedRunRequests.has(req)) return notFound("record");
    try {
      if (body.action === "calculate" || body.action === "dry-run") {
        const result = await calculatePayRun({
          orgId: gate.user.orgId,
          documentId: id,
          actorId: gate.user.id,
          dryRun: body.action === "dry-run",
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      // Apply one component amount across many employees in one pass — the
      // review step's bulk edit. Each employee still gets its own audited
      // adjustment row through the same helper as a single edit, and the whole
      // batch shares one transaction: a mid-loop failure rolls back every
      // adjustment instead of committing a partial set.
      if (body.action === "bulk-adjustment") {
        const { componentId, amount, note, replaceComponent } = body;
        // Every malformed shape refuses by name. One collapsed 'invalid
        // adjustment' over nine predicates meant a single bad id among two
        // thousand employees was undiagnosable — the refusal below names the
        // offending value AND its index. Same accept/refuse sets, split causes.
        if (typeof componentId !== "string") {
          return NextResponse.json(
            {
              error: `componentId must be a pay component id — got "${suppliedValue(componentId)}"; choose one from this run's adjustableComponents`,
            },
            { status: 422 },
          );
        }
        if (!isUuid(componentId)) {
          return NextResponse.json(
            {
              error: `componentId "${componentId}" is not a pay component id — choose one from this run's adjustableComponents`,
            },
            { status: 422 },
          );
        }
        if (!Array.isArray(body.employeePartyIds)) {
          return NextResponse.json(
            {
              error: `employeePartyIds must be a list of employee ids — got "${suppliedValue(body.employeePartyIds)}"; pass the employees to adjust as a list`,
            },
            { status: 422 },
          );
        }
        const employees = body.employeePartyIds;
        if (employees.length === 0) {
          return NextResponse.json(
            {
              error:
                "bulk-adjustment needs at least one employee — employeePartyIds is empty; pass the employees to adjust as a list",
            },
            { status: 422 },
          );
        }
        if (employees.length > 2000) {
          return NextResponse.json(
            {
              error: `bulk-adjustment accepts at most 2000 employees at once — got ${employees.length}; split the batch and try again`,
            },
            { status: 422 },
          );
        }
        const badIndex = employees.findIndex((v: unknown) => typeof v !== "string" || !isUuid(v));
        if (badIndex !== -1) {
          return NextResponse.json(
            {
              error: `employeePartyIds[${badIndex}] "${suppliedValue(employees[badIndex])}" is not an employee id — fix that entry and try again`,
            },
            { status: 422 },
          );
        }
        const amountRaw = canonicalDecimal(amount, 4);
        if (amountRaw === null) {
          return NextResponse.json(
            { error: decimalNullRefusal("amount", "an amount", amount, 4) },
            { status: 422 },
          );
        }
        if (note != null && typeof note !== "string") {
          return NextResponse.json(
            {
              error: `note must be text — got "${suppliedValue(note)}"; pass the note as text or omit it`,
            },
            { status: 422 },
          );
        }
        if (typeof note === "string" && note.length > 500) {
          return NextResponse.json(
            {
              error: `note is limited to 500 characters — got ${note.length}; shorten it and try again`,
            },
            { status: 422 },
          );
        }
        if (replaceComponent != null && typeof replaceComponent !== "boolean") {
          return NextResponse.json(
            {
              error: `replaceComponent must be true or false — got "${suppliedValue(replaceComponent)}"; pass a boolean or omit it`,
            },
            { status: 422 },
          );
        }
        // A replayed batch (double-clicked Apply, retried request) addresses
        // the same rows: each row id derives deterministically from the batch
        // key, so the engine replays instead of inserting twice. Same contract
        // as document creates — the key becomes the row id.
        const bulkKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
        if (bulkKey !== "" && !isUuid(bulkKey)) {
          return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
        }
        const canonicalAmount = normalizeMoney(amountRaw);
        const requestIds =
          bulkKey === ""
            ? null
            : (employees as string[]).map((employeePartyId) =>
                payRunBulkAdjustmentId(bulkKey, employeePartyId),
              );
        if (requestIds) {
          // Batch-level replay gate: a committed batch is all-or-nothing, so a
          // partial match means the key was reused for a different batch —
          // refuse rather than top it up.
          const existing = await db.execute<{
            id: string;
            employee_party_id: string;
            component_id: string | null;
            amount: string | null;
            hours: string | null;
            replace_component: boolean;
            note: string | null;
          }>(
            sql`
            select id::text as id, employee_party_id::text as employee_party_id,
                   component_id::text as component_id, amount::text as amount,
                   hours::text as hours, replace_component, note
              from pay_run_adjustments
             where org_id = ${gate.user.orgId} and pay_run_document_id = ${id}
               and adjustment_type = 'line'
               and id = any(${`{${requestIds.join(",")}}`}::uuid[])
          `,
            "objects",
          );
          if (existing.length > 0) {
            const byId = new Map(existing.map((row) => [row.id, row]));
            const replay =
              existing.length === requestIds.length &&
              (employees as string[]).every((employeePartyId, index) => {
                const row = byId.get(requestIds[index]!);
                return (
                  row !== undefined &&
                  row.employee_party_id === employeePartyId &&
                  row.component_id === componentId &&
                  normalizeMoney(row.amount ?? "0") === canonicalAmount &&
                  row.hours == null &&
                  row.replace_component === (replaceComponent ?? false) &&
                  (row.note ?? null) === (note ?? null)
                );
              });
            if (!replay)
              return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
            return NextResponse.json({ ok: true, applied: employees.length });
          }
        }
        try {
          await withOrgTransaction(gate.user.orgId, async () => {
            for (const [index, employeePartyId] of (employees as string[]).entries()) {
              await mutatePayRunAdjustment({
                orgId: gate.user.orgId,
                documentId: id,
                actorId: gate.user.id,
                allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
                mutation: {
                  action: "add",
                  employeePartyId,
                  componentId,
                  amount: canonicalAmount,
                  replaceComponent: replaceComponent ?? undefined,
                  note,
                  ...(requestIds ? { idempotencyKey: requestIds[index]! } : {}),
                },
              });
            }
          });
        } catch (e) {
          if (e instanceof PayRunAdjustmentIdempotencyConflict) {
            return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
          }
          throw e;
        }
        return NextResponse.json({ ok: true, applied: employees.length });
      }
      if (body.action === "preview-gl") {
        // Read-only: the exact legs commit would write, for the wizard's review
        // step. payroll.read suffices conceptually, but the wizard drives it and
        // the route is already gated payroll.run.
        const result = await previewPayRunGl(gate.user.orgId, id, gate.allowedSubsidiaryIds);
        return NextResponse.json({ ok: true, ...result });
      }
      if (body.action === "record-holiday-hours") {
        const hours = canonicalAdjustmentHours(body.hours);
        if (hours === null)
          return NextResponse.json(
            {
              error: decimalNullRefusal(
                "hours",
                "a non-negative number of paid hours",
                body.hours,
                2,
              ),
            },
            { status: 422 },
          );
        const key = req.headers.get("Idempotency-Key")?.trim() ?? "";
        if (key !== "" && !isUuid(key))
          return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
        try {
          const result = await recordPayRunHolidayHours({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            employeePartyId: body.employeePartyId,
            hours,
            earnedOn: body.earnedOn,
            reason: body.reason,
            note: body.note,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            ...(key === "" ? {} : { idempotencyKey: key }),
          });
          return NextResponse.json({ ok: true, ...result });
        } catch (e) {
          if (e instanceof PayRunAdjustmentIdempotencyConflict)
            return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
          throw e;
        }
      }
      if (body.action === "override-income-tax") {
        const amount = canonicalDecimal(body.amount, 2);
        if (amount === null) {
          return NextResponse.json(
            {
              error: decimalNullRefusal(
                "amount",
                "a non-negative absolute withholding amount in cents",
                body.amount,
                2,
              ),
            },
            { status: 422 },
          );
        }
        const requestKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
        if (!isUuid(requestKey)) {
          return NextResponse.json(
            {
              error:
                "override-income-tax requires a UUID Idempotency-Key; retry with a request key",
            },
            { status: 400 },
          );
        }
        try {
          const outcome = await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            reason: body.reason,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            mutation: {
              action: "override_income_tax",
              employeePartyId: body.employeePartyId,
              amount,
              reason: body.reason,
              sourceReference: body.sourceReference,
              idempotencyKey: requestKey,
            },
          });
          return NextResponse.json({ ok: true, ...outcome });
        } catch (e) {
          if (e instanceof PayRunAdjustmentIdempotencyConflict) {
            return NextResponse.json(
              { error: "invalid_idempotency_key", message: e.message },
              { status: 409 },
            );
          }
          throw e;
        }
      }
      if (body.action === "bank-cash-input") {
        const requestKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
        if (!isUuid(requestKey)) {
          return NextResponse.json(
            { error: "bank-cash-input requires a UUID Idempotency-Key; retry with a request key" },
            { status: 400 },
          );
        }
        try {
          const outcome = await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            reason: body.reason,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            mutation: {
              action: "bank_cash_input",
              employeePartyId: body.employeePartyId,
              componentId: body.componentId,
              hours: body.hours,
              amount: body.amount ?? null,
              rate: body.rate ?? null,
              outsideBankAmount: body.outsideBankAmount ?? null,
              reason: body.reason,
              sourceReference: body.sourceReference,
              idempotencyKey: requestKey,
            },
          });
          return NextResponse.json({ ok: true, ...outcome });
        } catch (e) {
          if (e instanceof PayRunAdjustmentIdempotencyConflict) {
            return NextResponse.json(
              { error: "invalid_idempotency_key", message: e.message },
              { status: 409 },
            );
          }
          throw e;
        }
      }
      if (body.action === "declared-vacation-accrual") {
        const amount = canonicalDecimal(body.amount, 2);
        if (amount === null || amount.startsWith("-")) {
          return NextResponse.json(
            {
              error: decimalNullRefusal(
                "amount",
                "a positive declared vacation accrual in cents",
                body.amount,
                2,
              ),
            },
            { status: 422 },
          );
        }
        const requestKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
        if (!isUuid(requestKey)) {
          return NextResponse.json(
            {
              error:
                "declared-vacation-accrual requires a UUID Idempotency-Key; retry with a request key",
            },
            { status: 400 },
          );
        }
        try {
          const outcome = await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            reason: body.reason,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            mutation: {
              action: "declared_vacation_accrual",
              employeePartyId: body.employeePartyId,
              amount,
              reason: body.reason,
              sourceReference: body.sourceReference,
              idempotencyKey: requestKey,
            },
          });
          return NextResponse.json({ ok: true, ...outcome });
        } catch (e) {
          if (e instanceof PayRunAdjustmentIdempotencyConflict) {
            return NextResponse.json(
              { error: "invalid_idempotency_key", message: e.message },
              { status: 409 },
            );
          }
          throw e;
        }
      }
      if (body.action === "employer-levy-adjustment") {
        const amount = canonicalDecimal(body.amount, 2);
        if (amount === null) {
          return NextResponse.json(
            {
              error: decimalNullRefusal(
                "amount",
                "the issued levy premium amount in cents",
                body.amount,
                2,
              ),
            },
            { status: 422 },
          );
        }
        const requestKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
        if (!isUuid(requestKey)) {
          return NextResponse.json(
            {
              error:
                "employer-levy-adjustment requires a UUID Idempotency-Key; retry with a request key",
            },
            { status: 400 },
          );
        }
        try {
          const outcome = await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            reason: body.reason,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            mutation: {
              action: "employer_levy_adjustment",
              employeePartyId: body.employeePartyId,
              programKey: body.programKey,
              workerCompGroupId: body.workerCompGroupId ?? null,
              amount,
              sourceKey: body.sourceKey,
              reason: body.reason,
              sourceReference: body.sourceReference,
              idempotencyKey: requestKey,
            },
          });
          return NextResponse.json({ ok: true, ...outcome });
        } catch (e) {
          if (e instanceof PayRunAdjustmentIdempotencyConflict) {
            return NextResponse.json(
              { error: "invalid_idempotency_key", message: e.message },
              { status: 409 },
            );
          }
          throw e;
        }
      }
      if (body.action === "add-adjustment") {
        const { employeePartyId, componentId, amount, hours, note, replaceComponent } = body;
        const amountRaw = canonicalDecimal(amount, 4);
        // Hours persist into numeric(12,2): canonicalize at that scale, never
        // through the 4dp money normalizer (its padding fails the engine gate
        // for every hours value). The engine re-validates before persisting.
        // Malformed shapes refuse by name; signed bank candidates additionally
        // need the native writer's plan and component validation.
        let hoursRaw: string | null = null;
        if (hours != null && hours !== "") {
          // A signed candidate still needs the writer's active-bank validation.
          hoursRaw = canonicalAdjustmentHours(hours, amountRaw);
          if (hoursRaw === null) {
            const hoursExact = canonicalDecimal(hours, 2);
            if (hoursExact !== null && hoursExact.startsWith("-") && !amountRaw?.startsWith("-")) {
              return NextResponse.json(
                {
                  error: `hours must not be negative — got "${suppliedValue(hours)}"; pass zero or more hours, or omit hours`,
                },
                { status: 422 },
              );
            }
            if (
              hoursExact !== null &&
              hoursExact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 10
            ) {
              return NextResponse.json(
                {
                  error: `hours is out of range — at most 10 whole digits fit; got "${suppliedValue(hours)}"; enter fewer hours and try again`,
                },
                { status: 422 },
              );
            }
            return NextResponse.json(
              { error: decimalNullRefusal("hours", "a number of hours", hours, 2) },
              { status: 422 },
            );
          }
        }
        if (typeof employeePartyId !== "string") {
          return NextResponse.json(
            {
              error: `employeePartyId must be an employee id — got "${suppliedValue(employeePartyId)}"; pass the employee as an employee id`,
            },
            { status: 422 },
          );
        }
        if (!isUuid(employeePartyId)) {
          return NextResponse.json(
            {
              error: `employeePartyId "${employeePartyId}" is not an employee id — fix the id and try again`,
            },
            { status: 422 },
          );
        }
        if (typeof componentId !== "string") {
          return NextResponse.json(
            {
              error: `componentId must be a pay component id — got "${suppliedValue(componentId)}"; choose one from this run's adjustableComponents`,
            },
            { status: 422 },
          );
        }
        if (!isUuid(componentId)) {
          return NextResponse.json(
            {
              error: `componentId "${componentId}" is not a pay component id — choose one from this run's adjustableComponents`,
            },
            { status: 422 },
          );
        }
        if (amountRaw === null) {
          return NextResponse.json(
            { error: decimalNullRefusal("amount", "an amount", amount, 4) },
            { status: 422 },
          );
        }
        if (note != null && typeof note !== "string") {
          return NextResponse.json(
            {
              error: `note must be text — got "${suppliedValue(note)}"; pass the note as text or omit it`,
            },
            { status: 422 },
          );
        }
        if (typeof note === "string" && note.length > 500) {
          return NextResponse.json(
            {
              error: `note is limited to 500 characters — got ${note.length}; shorten it and try again`,
            },
            { status: 422 },
          );
        }
        if (replaceComponent != null && typeof replaceComponent !== "boolean") {
          return NextResponse.json(
            {
              error: `replaceComponent must be true or false — got "${suppliedValue(replaceComponent)}"; pass a boolean or omit it`,
            },
            { status: 422 },
          );
        }
        // A replayed add (double-clicked Save, retried request) carries the
        // form session's key, which becomes the adjustment row id — the same
        // contract as document creates — so the replay returns the original
        // result instead of a second adjustment.
        const adjustmentKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
        if (adjustmentKey !== "" && !isUuid(adjustmentKey)) {
          return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
        }
        try {
          await mutatePayRunAdjustment({
            orgId: gate.user.orgId,
            documentId: id,
            actorId: gate.user.id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            mutation: {
              action: "add",
              employeePartyId,
              componentId,
              amount: normalizeMoney(amountRaw),
              hours: hoursRaw,
              earnedFrom: body.earnedFrom,
              earnedTo: body.earnedTo,
              replaceComponent: replaceComponent ?? undefined,
              note,
              ...(adjustmentKey === "" ? {} : { idempotencyKey: adjustmentKey }),
            },
          });
        } catch (e) {
          if (e instanceof PayRunAdjustmentIdempotencyConflict) {
            return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
          }
          throw e;
        }
        return NextResponse.json({ ok: true });
      }
      if (body.action === "delete-adjustment") {
        if (typeof body.adjustmentId !== "string") {
          return NextResponse.json(
            {
              error: `adjustmentId must be a pay adjustment id — got "${suppliedValue(body.adjustmentId)}"; pass the adjustment to delete as an id`,
            },
            { status: 422 },
          );
        }
        if (!isUuid(body.adjustmentId)) {
          return NextResponse.json(
            {
              error: `adjustmentId "${body.adjustmentId}" is not a pay adjustment id — fix the id and try again`,
            },
            { status: 422 },
          );
        }
        await mutatePayRunAdjustment({
          orgId: gate.user.orgId,
          documentId: id,
          actorId: gate.user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          mutation: { action: "delete", adjustmentId: body.adjustmentId },
        });
        return NextResponse.json({ ok: true });
      }
      // Bulk scope: set the run's included employees in one call. Everyone on
      // the roster who is NOT in `employeePartyIds` gets an exclusion row; those
      // in it have theirs removed. Changed members go through the same audited
      // helper one at a time — no second write path — and the whole diff is one
      // transaction, so a partial scope can never be committed.
      if (body.action === "set-scope") {
        // Every malformed shape refuses by name. One collapsed 'invalid
        // scope' over two lists, a limit and two entry checks meant a single bad id on
        // a 2000-employee roster was undiagnosable — the refusal below names
        // the offending value AND its index. Same accept/refuse set, split
        // causes: an empty included list still excludes everyone, and an empty
        // roster is still a no-op.
        if (!Array.isArray(body.employeePartyIds)) {
          return NextResponse.json(
            {
              error: `employeePartyIds must be a list of employee ids — got "${suppliedValue(body.employeePartyIds)}"; pass the employees to include as a list`,
            },
            { status: 422 },
          );
        }
        if (!Array.isArray(body.rosterPartyIds)) {
          return NextResponse.json(
            {
              error: `rosterPartyIds must be a list of employee ids — got "${suppliedValue(body.rosterPartyIds)}"; pass the run roster as a list`,
            },
            { status: 422 },
          );
        }
        const included = body.employeePartyIds;
        const roster = body.rosterPartyIds;
        if (roster.length > 2000) {
          return NextResponse.json(
            {
              error: `set-scope accepts at most 2000 roster employees at once — got ${roster.length}; split the roster and try again`,
            },
            { status: 422 },
          );
        }
        const badIncluded = included.findIndex((v: unknown) => typeof v !== "string" || !isUuid(v));
        if (badIncluded !== -1) {
          return NextResponse.json(
            {
              error: `employeePartyIds[${badIncluded}] "${suppliedValue(included[badIncluded])}" is not an employee id — fix that entry and try again`,
            },
            { status: 422 },
          );
        }
        const badRoster = roster.findIndex((v: unknown) => typeof v !== "string" || !isUuid(v));
        if (badRoster !== -1) {
          return NextResponse.json(
            {
              error: `rosterPartyIds[${badRoster}] "${suppliedValue(roster[badRoster])}" is not an employee id — fix that entry and try again`,
            },
            { status: 422 },
          );
        }
        const keep = new Set(included as string[]);
        const rosterSet = new Set(roster as string[]);
        // A keep id that is not on the roster would be silently ignored by the
        // loop below (and used to be COUNTED as included). That is either a
        // stale client roster or a mistyped id on a 2000-employee list — refuse
        // naming it rather than answering counts that describe nothing.
        const offRoster = (included as string[]).find((id) => !rosterSet.has(id));
        if (offRoster !== undefined) {
          return NextResponse.json(
            {
              error: `employeePartyIds "${offRoster}" is not on this run's roster — pass only roster members to include, and refresh the roster first`,
            },
            { status: 422 },
          );
        }
        // True deltas, not input echoes: members already where they belong are
        // skipped below, so the counts report the memberships that actually
        // changed.
        let includedDelta = 0;
        let excludedDelta = 0;
        await withOrgTransaction(gate.user.orgId, async () => {
          // DIFF against the current scope, never replay the roster. Every
          // mutatePayRunAdjustment call re-validates its member, so looping the
          // whole roster re-checks people whose scope is not changing — and one
          // of them (a deactivated employee, an edited profile) rolls back the
          // entire transaction. A member already in scope and staying, or
          // already out and staying out, is not being changed and is skipped;
          // only actual additions and removals are validated. That closes this
          // trap for every predicate, not just the active-member one.
          const excludedRows = await db.execute<{ employee_party_id: string }>(
            sql`
            select employee_party_id from pay_run_adjustments
             where org_id = ${gate.user.orgId} and pay_run_document_id = ${id}
               and adjustment_type = 'exclude'
          `,
            "objects",
          );
          const excluded = new Set(excludedRows.map((row) => row.employee_party_id));
          for (const employeePartyId of roster as string[]) {
            const wanted = keep.has(employeePartyId) ? "include" : "exclude";
            const current = excluded.has(employeePartyId) ? "exclude" : "include";
            if (wanted === current) continue;
            const outcome = await mutatePayRunAdjustment({
              orgId: gate.user.orgId,
              documentId: id,
              actorId: gate.user.id,
              allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
              mutation: { action: wanted, employeePartyId },
            });
            // The write's own receipt: count the membership only when the
            // mutation reports it changed, never because the input named it.
            if (outcome.changed) {
              if (wanted === "include") includedDelta++;
              else excludedDelta++;
            }
          }
        });
        return NextResponse.json({ ok: true, included: includedDelta, excluded: excludedDelta });
      }
      if (body.action === "exclude-employee" || body.action === "include-employee") {
        if (typeof body.employeePartyId !== "string") {
          return NextResponse.json(
            {
              error: `employeePartyId must be an employee id — got "${suppliedValue(body.employeePartyId)}"; pass the employee as an employee id`,
            },
            { status: 422 },
          );
        }
        if (!isUuid(body.employeePartyId)) {
          return NextResponse.json(
            {
              error: `employeePartyId "${body.employeePartyId}" is not an employee id — fix the id and try again`,
            },
            { status: 422 },
          );
        }
        await mutatePayRunAdjustment({
          orgId: gate.user.orgId,
          documentId: id,
          actorId: gate.user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          mutation: {
            action: body.action === "exclude-employee" ? "exclude" : "include",
            employeePartyId: body.employeePartyId,
          },
        });
        return NextResponse.json({ ok: true });
      }
      if (body.action === "resolve-employment-links") {
        // One-click repair for the readiness "no payroll link" blocker: link
        // every unlinked profile that has exactly one active employment. The
        // engine refuses the rest BY NAME (no employment, ended, several),
        // so the response tells the operator who still needs a manual link.
        const requested = Array.isArray(body.employeePartyIds)
          ? body.employeePartyIds.filter((id): id is string => typeof id === "string")
          : undefined;
        if (requested?.length) {
          const deniedEmployees = await guardPayrollEmployees(gate, requested);
          if (deniedEmployees) return deniedEmployees;
        }
        const links = await resolvePayrollProfileEmploymentLinks({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          employeePartyIds: requested?.length ? requested : undefined,
          reason: "Pay-run readiness Resolve action",
          dryRun: false,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        return NextResponse.json({ ok: true, linked: links.linked, unresolved: links.unresolved });
      }
      if (body.action === "email-stubs") {
        const result = await emailRunStubs(gate.user.orgId, id, gate.allowedSubsidiaryIds);
        // Total renderer outage across the batch: every per-item entry carries
        // the named refusal but the UI lists only names, so answer the 503
        // here rather than ok:true with N hidden causes. Tenant refusals
        // (opaque run, policy) throw before any render and keep their status.
        if (result.sent === 0 && result.rendererOutage) {
          const rendererRefusal = rendererStatusResponse();
          if (rendererRefusal) return rendererRefusal;
        }
        return NextResponse.json({ ok: true, ...result });
      }
      if (body.action === "record-payment") {
        // Bank and clearing settlement are distinct inputs: exactly one names the account.
        if (
          (body.bankAccountId === undefined) ===
          (body.settlementClearingAccountId === undefined)
        ) {
          return NextResponse.json(
            { error: "choose either a bank account or the designated settlement clearing account" },
            { status: 422 },
          );
        }
        const result = await recordPayRunPayment({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          documentId: id,
          ...(body.bankAccountId !== undefined
            ? { bankAccountId: body.bankAccountId }
            : { settlementClearingAccountId: body.settlementClearingAccountId }),
          ...(body.paidOn !== undefined ? { paidOn: body.paidOn } : {}),
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      // Submit for approval: assemble the evidence package (payroll journal +
      // register + GL preview) onto the run, then route it through Flows. A
      // tenant with no pay_run flow gets `gated: false` and releases immediately.
      if (body.action === "submit-approval") {
        const submitted = await submitPayRunForApproval({
          orgId: gate.user.orgId,
          userId: gate.user.id,
          documentId: id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        if (!submitted.ok) return NextResponse.json({ error: submitted.error }, { status: 422 });
        return NextResponse.json({
          ok: true,
          evidence: submitted.evidence,
          gated: submitted.gated,
        });
      }
      // Recalculate an approved run whose inputs changed after approval. The
      // engine withdraws the approval (audited, with the stale inputs as the
      // reason) and recalculates in one transaction; the run then goes back
      // through its approval Flow, so commit stays refused until re-approved.
      // Withdrawing an approval takes the same permission as the generic
      // return-to-draft action for this document kind.
      if (body.action === "recalculate-approved") {
        const withdrawPermission =
          documentKindPermissions("pay_run")?.approve ?? postPermission("pay_run");
        if (!can(gate, withdrawPermission)) {
          return NextResponse.json(
            { error: `missing permission: ${withdrawPermission}` },
            { status: 403 },
          );
        }
        const recalculated = await recalculateStaleApprovedPayRun({
          orgId: gate.user.orgId,
          documentId: id,
          actorId: gate.user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        const base = { ok: true, ...recalculated.calculation, reasons: recalculated.reasons };
        const approval = await payRunApprovalState(gate.user.orgId, id);
        if (!approval.policyExists)
          return NextResponse.json({ ...base, resubmitted: false, gated: false });
        // The recalculation has already committed. A refused resubmission leaves the
        // run in draft with its fresh figures, and the refusal names that state.
        const resubmitted = await submitPayRunForApproval({
          orgId: gate.user.orgId,
          userId: gate.user.id,
          documentId: id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        }).catch((error: unknown) => {
          if (error instanceof PayrollError) return { ok: false as const, error: error.message };
          throw error;
        });
        if (!resubmitted.ok) {
          return NextResponse.json(
            {
              error: `The run was recalculated and returned to draft, but it was not sent for approval: ${resubmitted.error}`,
            },
            { status: 422 },
          );
        }
        return NextResponse.json({ ...base, resubmitted: true, gated: resubmitted.gated });
      }
      if (body.action === "approval-state") {
        return NextResponse.json({ ok: true, ...(await payRunApprovalState(gate.user.orgId, id)) });
      }
      // Record an explicit decision to commit while in-scope employees are
      // refused. Taken against the run's CURRENT stored refusal set server-side
      // — never a caller-supplied list — so the acknowledgement necessarily
      // names exactly who is being left out, with the refusal text verbatim.
      if (body.action === "acknowledge-refusals") {
        const acknowledgement = await acknowledgePayRunRefusals({
          orgId: gate.user.orgId,
          documentId: id,
          actorId: gate.user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        return NextResponse.json({ ok: true, acknowledgement });
      }
      // Attribute a committed run that was committed with no subsidiary
      // (legacy): the boundary lives in the engine (`attributePayRunEntity`) —
      // the header aligns null → target, posted books are never rewritten
      // (anything naming another entity refuses), with an audited trail.
      // Scoped roles cannot see an unattributed run at all, so attribution
      // stays an org-wide act: the guard below 404s them exactly like a
      // missing run, and the engine re-checks target scope.
      if (body.action === "attribute-entity") {
        if (typeof body.subsidiaryId !== "string" || !isUuid(body.subsidiaryId)) {
          return NextResponse.json(
            { error: "choose a subsidiary to attribute this run to" },
            { status: 422 },
          );
        }
        const owned = (
          await db.execute<{ subsidiaryId: string | null }>(
            sql`
          select d.subsidiary_id as "subsidiaryId"
            from pay_runs r
            join documents d on d.id = r.document_id and d.org_id = r.org_id
           where r.org_id = ${gate.user.orgId} and r.document_id = ${id}`,
            "objects",
          )
        )[0];
        if (!owned) return notFound("record");
        const denied = guardSubsidiaryScope(gate, owned.subsidiaryId);
        if (denied) return denied;
        const result = await attributePayRunEntity({
          orgId: gate.user.orgId,
          documentId: id,
          actorId: gate.user.id,
          subsidiaryId: body.subsidiaryId,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      if (body.action === "commit") {
        // Money must not move before approval: commit materializes the GL
        // projection and claims the period's time entries. Nor may it move on
        // figures the operator edited past: the wizard's stale banner is only
        // the rendering of the engine check — this boundary enforces it, so a
        // stale tab or a scripted call cannot commit a calculation its inputs
        // outlived. (The wizard reads the same `payRunStaleness`; one source of
        // truth, two consumers — render and refuse.)
        await assertPayRunNotStale(gate.user.orgId, id, db, gate.allowedSubsidiaryIds);
        await assertPayRunApprovalReleased(gate.user.orgId, id);
        // The engine's native commit transaction enforces the anomaly gate
        // against the locked run and its actual schedule/entity roster.
        const result = await commitPayRun({
          orgId: gate.user.orgId,
          documentId: id,
          actorId: gate.user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        return NextResponse.json({ ok: true, ...result });
      }
    } catch (e) {
      if (e instanceof PayrollError) return apiErrorResponse(e, { safeStatus: 422 });
      throw e;
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  },
});

/**
 * Discard a draft pay run.
 *
 * The boundary lives in the engine (`discardPayRun`): only an uncommitted
 * run on a draft document with no GL lines and no payment goes. A committed
 * or posted run is refused there with the void remedy — discarding is not a
 * quiet void. Missing and out-of-scope runs answer the same 404.
 */
export const DELETE = defineRoute({
  permission: "payroll.run",
  feature: "payroll",
  params: z.object({ id: z.string() }),
  body: z.strictObject({ reason: z.string().trim().min(1).max(2000).optional() }).optional(),
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const params = Promise.resolve(routeParams);
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const owned = (
      await db.execute<{ subsidiaryId: string | null }>(
        sql`
      select d.subsidiary_id as "subsidiaryId"
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${gate.user.orgId} and r.document_id = ${id}`,
        "objects",
      )
    )[0];
    if (!owned) return notFound("record");
    const denied = guardSubsidiaryScope(gate, owned.subsidiaryId);
    if (denied) return denied;
    try {
      const result = await discardPayRun({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        reason: body?.reason,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof PayrollError) {
        // A missing run reads 404; every other payroll refusal stays 422.
        // The engine raises both as PayrollError, so the route keeps the
        // historical message match to select the status.
        return apiErrorResponse(
          e,
          e.message === "pay run not found" ? { safeStatus: 404 } : { safeStatus: 422 },
        );
      }
      throw e;
    }
  },
});
