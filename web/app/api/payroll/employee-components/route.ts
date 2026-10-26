import { uuidId } from "@/lib/api/json-schema";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date";
import { isUuid } from "../../../../lib/list-params";
import { canonicalDecimal } from "../../../../lib/exact-decimal";
import { decimalNullRefusal } from "../../../../lib/payroll-decimal-refusal";
import {
  saveEmployeePayComponentAssignment,
  listEmployeePayComponentAssignments,
  endEmployeePayComponentAssignment,
  deleteUnusedEmployeePayComponentAssignment,
  ScopeNotFoundError,
  ASSIGNMENT_RUN_APPLICABILITIES,
  PayrollError,
} from "@openbooks/engine/payroll/assigned-components";
import { notFound } from "@/lib/api/responses";

export const dynamic = "force-dynamic";

/**
 * Recurring per-employee pay-component assignments — the write side of the
 * rows the pay run prices every regular period (fixed deductions, taxable
 * benefits, employee premiums).
 *
 * GET  ?employee=<partyId>  one employee's assignments + the user-defined
 *                           components they may take + their employments.
 * POST { action:'save-assignment' }  insert one effective-dated row.
 * POST { action:'end-assignment' }    set/clear a row's effective_to.
 * POST { action:'delete-assignment' } remove a row that never reached a stub.
 *
 * Every mutation validates through the payroll service (statutory components
 * refuse, overlaps refuse, Benefits-delivered components refuse naming the
 * rule) and appends an audit_log row with the exact before/after state in the
 * same transaction. A storage refusal past validation (the 0250 overlap
 * exclusion under race) maps to a stable code, never driver text.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const decimalText = (field: string, noun: string) =>
  z.unknown().transform((value, ctx) => {
    if (typeof value !== "string" || canonicalDecimal(value, 4) === null) {
      ctx.addIssue({ code: "custom", message: decimalNullRefusal(field, noun, value, 4) });
      return z.NEVER;
    }
    return value;
  });

const postBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save-assignment"),
    employeePartyId: uuidId,
    employmentId: uuidId.nullable().optional(),
    componentId: uuidId,
    runApplicability: z.enum(ASSIGNMENT_RUN_APPLICABILITIES).default("standard_runs"),
    value: decimalText("value", "an exact decimal amount").nullable().optional(),
    effectiveFrom: z.string().regex(DATE_RE),
    effectiveTo: z.string().regex(DATE_RE).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("end-assignment"),
    id: uuidId,
    effectiveTo: z.string().regex(DATE_RE).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("delete-assignment"),
    id: uuidId,
    reason: z.string().trim().max(500).optional(),
  }),
]);

/** Client calendar dates that PostgreSQL would refuse with driver text. */
function invalidDate(value: unknown): boolean {
  return typeof value !== "string" || !DATE_RE.test(value) || !isIsoCalendarDate(value);
}

/** The 0250 overlap exclusion, anywhere in a cause chain. */
function isOverlapConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (
      candidate.code === "23P01" &&
      candidate.constraint === "employee_pay_components_no_active_overlap"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function storageRefusal(error: unknown): { error: string; errorCode: string } {
  if (isOverlapConflict(error)) {
    return {
      error: "this assignment overlaps an existing assignment for the same component",
      errorCode: "overlap",
    };
  }
  return { error: "could not save the pay-component assignment", errorCode: "save" };
}

function refusalResponse(error: unknown): NextResponse {
  if (error instanceof ScopeNotFoundError) return notFound("record");
  if (error instanceof PayrollError)
    return NextResponse.json({ error: error.message }, { status: 422 });
  return NextResponse.json(storageRefusal(error), { status: 422 });
}

export const GET = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  handler: async ({ request: req, authz: gate }) => {
    const orgId = gate.user.orgId;
    const employee = new URL(req.url).searchParams.get("employee");
    if (!employee || !isUuid(employee))
      return NextResponse.json({ error: "employee required" }, { status: 422 });
    try {
      const result = await listEmployeePayComponentAssignments({
        orgId,
        employeePartyId: employee,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      throw error;
    }
  },
});

export const POST = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  body: postBodySchema,
  handler: async ({ body, authz: gate }) => {
    const actor = { orgId: gate.user.orgId, actorId: gate.user.id, reason: body.reason };
    try {
      if (body.action === "save-assignment") {
        if (invalidDate(body.effectiveFrom))
          return NextResponse.json(
            { error: "effectiveFrom (YYYY-MM-DD) required" },
            { status: 422 },
          );
        if (body.effectiveTo != null && invalidDate(body.effectiveTo))
          return NextResponse.json({ error: "invalid effectiveTo" }, { status: 422 });
        const after = await saveEmployeePayComponentAssignment({
          ...actor,
          employeePartyId: body.employeePartyId,
          employmentId: body.employmentId ?? null,
          componentId: body.componentId,
          value: body.value ?? null,
          runApplicability: body.runApplicability,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo ?? null,
        });
        return NextResponse.json({ ok: true, id: after.id });
      }
      if (body.action === "end-assignment") {
        if (body.effectiveTo != null && invalidDate(body.effectiveTo))
          return NextResponse.json({ error: "invalid effectiveTo" }, { status: 422 });
        await endEmployeePayComponentAssignment({
          ...actor,
          id: body.id,
          effectiveTo: body.effectiveTo ?? null,
        });
      } else {
        await deleteUnusedEmployeePayComponentAssignment({ ...actor, id: body.id });
      }
      return NextResponse.json({ ok: true });
    } catch (error) {
      return refusalResponse(error);
    }
  },
});
