import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HrmConstructionError } from "./errors.ts";

/**
 * Shared construction-compliance plumbing (HR-13): feature asserts
 * rechecked inside every public transaction, id/date validation, and the
 * transaction helper. Every public entry runs its checks and writes on
 * the transaction runner so each check and its write are atomic — one
 * transaction per user action, partial effects roll back.
 */

export const HRM_CONSTRUCTION_FEATURE = "hrmConstructionCompliance" as const;
export const HRM_PREVAILING_WAGE_FEATURE = "hrmPrevailingWage" as const;
export const HRM_CERTIFIED_PAYROLL_FEATURE = "hrmCertifiedPayroll" as const;
export const HRM_WORKERS_COMP_FEATURE = "hrmWorkersCompClasses" as const;
export const HRM_APPRENTICE_RATIO_FEATURE = "hrmApprenticeRatios" as const;
export const HRM_PER_DIEM_FEATURE = "hrmPerDiem" as const;

export async function assertConstructionFeature(
  exec: SqlExecutor,
  orgId: string,
  feature: string,
  what: string,
): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, feature))) {
    throw new HrmConstructionError(
      `${what} is unavailable while the ${feature} feature is off — enable it under Company Settings → Features; existing construction-compliance data is preserved.`,
    );
  }
}

export function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HrmConstructionError(`${field} must be a non-empty id string.`);
  }
  return value;
}

export function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HrmConstructionError(`${field} must be a YYYY-MM-DD date.`);
  }
  return value;
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HrmConstructionError(`${field} must be a non-blank string.`);
  }
  return value.trim();
}

export { db, withOrgTransaction, type SqlExecutor };

export async function loadOrgCountry(exec: SqlExecutor, orgId: string): Promise<string> {
  const rows = (
    await exec.execute<{ country: string }>(sql`
      select country from orgs where id = ${orgId}::uuid
    `)
  ).rows;
  const country = rows[0]?.country;
  if (!country) {
    throw new HrmConstructionError(
      "The organization has no home country — set it before generating labor-compliance files.",
    );
  }
  return country;
}
