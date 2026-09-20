import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { BenefitsError } from "./errors.ts";
import { parseCivilDate } from "../temporal.ts";

/**
 * Shared benefits service plumbing: the HRM feature gate (rechecked inside
 * every public transaction), id/date validation, and the transaction
 * helper. Every public entry runs its checks and writes on the transaction
 * runner so each check and its write are atomic.
 */

export async function assertHrmEnabled(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new BenefitsError(
      "REFUSED",
      "benefits are unavailable while the hrm feature is off — enable it under Company Settings → Features; existing benefits data is preserved",
    );
  }
}

export function requireOrgId(orgId: unknown): string {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new BenefitsError("INVALID_INPUT", "orgId must be a non-empty string");
  }
  return orgId;
}

export function requireActorId(actorId: unknown): string {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new BenefitsError("INVALID_INPUT", "actorId must be a non-empty string");
  }
  return actorId;
}

export function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BenefitsError("INVALID_INPUT", `${field} must be a non-empty id string`);
  }
  return value;
}

/** Strict civil date (YYYY-MM-DD), refused with the remedy otherwise. */
export function requireCivilDate(value: unknown, field: string): string {
  try {
    return parseCivilDate(value);
  } catch {
    throw new BenefitsError("INVALID_INPUT", `${field} must be a civil date (YYYY-MM-DD)`);
  }
}

/** Zero matched rows is a failure, never a success (RLS-shaped silence). */
export function requireOneRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) {
    throw new BenefitsError(
      "REFUSED",
      `${what} matched no row — it is missing, outside this organization, or outside your scope; reload and retry`,
    );
  }
  return row;
}

export { db, withOrgTransaction, type SqlExecutor, sql };
