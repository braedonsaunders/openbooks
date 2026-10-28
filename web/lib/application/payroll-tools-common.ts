import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { isFeatureEnabled } from "../features";
import { can, subsidiaryScopeAllows, type Authz } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { payrollRunDocumentScope } from "@openbooks/engine/payroll/run-document-reads";
import { guardPayrollEmployees } from "../payroll/subsidiary-scope";

/** UUID pattern stays provider-safe: strict tool consumers reject format: uuid. */
export const UUID = (help = "UUID copied from a payroll read result; never invent one.") =>
  z.string().regex(UUID_RE).describe(help);

export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isIsoCalendarDate)
  .describe("Calendar date (YYYY-MM-DD).");
export const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

export const payrollActor = (permission: string) => (authz: Authz) => can(authz, permission);

export async function assertPayrollFeature(context: ApplicationContext, feature = "payroll") {
  if (!(await isFeatureEnabled(context.authz.user.orgId, feature))) throw notFound("record");
}

export async function assertPayrollActor(context: ApplicationContext, permission: string) {
  assertApplicationPermission(context, permission);
  await assertPayrollFeature(context);
}

export async function assertPayRunAccess(context: ApplicationContext, documentId: string) {
  const scope = await payrollRunDocumentScope(context.authz.user.orgId, documentId);
  if (!scope || !subsidiaryScopeAllows(context.authz.allowedSubsidiaryIds, scope.subsidiaryId)) {
    throw notFound("record");
  }
  return scope;
}

export async function assertPayrollEmployeeAccess(
  context: ApplicationContext,
  employeeIds: readonly string[],
) {
  const denial = await guardPayrollEmployees(context.authz, employeeIds);
  if (denial) throw notFound("record");
}

/** Match the root-subsidiary scope required by org-wide payroll configuration routes. */
export async function assertPayrollRootScope(context: ApplicationContext) {
  if (context.authz.allowedSubsidiaryIds === null) return;
  const root = (
    await db.execute<{ id: string }>(
      sql`
      select id from subsidiaries
       where org_id = ${context.authz.user.orgId} and parent_id is null and is_active
       order by created_at limit 1`,
      "objects",
    )
  )[0]?.id;
  if (!root || !context.authz.allowedSubsidiaryIds.has(root)) throw notFound("record");
}

export function assertPayrollUnrestrictedScope(context: ApplicationContext) {
  if (context.authz.allowedSubsidiaryIds !== null) {
    throw new ApplicationError("forbidden", "requires unrestricted subsidiary access", 403, {
      remedy:
        "Request unrestricted subsidiary access to manage organization-wide payroll configuration.",
    });
  }
}

/** Preserve payroll's named refusal and its established route status. */
export function settlePayrollRefusal(error: unknown, safeStatus = 422): never {
  if (!(error instanceof PayrollError)) throw error;
  if (error.message.toLowerCase().includes("not found")) {
    throw new ApplicationError("not_found", error.message, 404);
  }
  if (safeStatus === 409) {
    throw new ApplicationError("conflict", error.message, 409);
  }
  throw invalidInput(error.message);
}
