import { db, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HrmQualificationError } from "./errors.ts";

/**
 * Shared qualification plumbing (HR-14, migration 0225): feature asserts
 * rechecked inside every public transaction, id/date validation, the
 * derived-status projection, and the transaction helper. Every public
 * entry runs its checks and writes on the transaction runner so each
 * check and its write are atomic — one transaction per user action,
 * partial effects roll back.
 */

export const HRM_CERTIFICATIONS_FEATURE = "hrmCertifications" as const;
export const HRM_DISPATCH_GATING_FEATURE = "hrmDispatchGating" as const;
export const HRM_EQUIPMENT_QUALIFICATIONS_FEATURE = "hrmEquipmentQualifications" as const;
export const HRM_CERTIFICATION_ALERTS_FEATURE = "hrmCertificationAlerts" as const;

export async function assertQualificationsFeature(
  exec: SqlExecutor,
  orgId: string,
  feature: string,
  what: string,
): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, feature))) {
    throw new HrmQualificationError(
      `${what} is unavailable while the ${feature} feature is off — enable it under Company Settings → Features; existing qualification data is preserved.`,
    );
  }
}

export function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HrmQualificationError(`${field} must be a non-empty id string.`);
  }
  return value;
}

export function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HrmQualificationError(`${field} must be a YYYY-MM-DD date.`);
  }
  return value;
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HrmQualificationError(`${field} must be a non-blank string.`);
  }
  return value.trim();
}

export { db, type SqlExecutor };

/**
 * Participate in the caller's unit of work. Qualification services never
 * open their own transaction: mutating API routes compose with
 * withOrgTransaction(orgId, …) and thread the runner down, and nested
 * service calls (renew → record, hook → gate) join the same unit — so
 * each check and its write stay atomic and partial effects roll back.
 * One transaction per user action, owned by the outermost caller.
 */
export async function runInCallerTransaction<T>(
  exec: SqlExecutor,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  return fn(exec);
}

/** Stored statuses (what storage may hold — never expiring/expired). */
export type StoredQualificationStatus = "valid" | "revoked" | "pending_verification";

/** Read statuses (stored plus the two derived projections). */
export type DerivedQualificationStatus =
  | StoredQualificationStatus
  | "expiring"
  | "expired";

function addDaysUtc(ymd: string, days: number): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * The derived-status projection (pure, unit-tested at the boundaries).
 *
 * Storage holds only valid | revoked | pending_verification; expiring and
 * expired are derived at read from expires_on and the type's lead days.
 * Boundary rule: expiry day itself still counts (the worker may be on the
 * job that day), so expires_on == today projects expiring, and expired
 * starts the day after. pending_verification never derives — an
 * unverified credential is pending no matter how far off expiry is.
 */
export function projectDerivedStatus(args: {
  stored: StoredQualificationStatus;
  expiresOn: string | null;
  leadDays: number;
  today: string;
}): DerivedQualificationStatus {
  if (args.stored === "revoked" || args.stored === "pending_verification") return args.stored;
  if (!args.expiresOn) return "valid";
  if (args.expiresOn < args.today) return "expired";
  if (args.expiresOn <= addDaysUtc(args.today, Math.max(0, args.leadDays))) return "expiring";
  return "valid";
}

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const parts = ymd.split("-").map(Number);
  const y = parts[0] ?? NaN;
  const m = parts[1] ?? NaN;
  const d = parts[2] ?? NaN;
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new HrmQualificationError(`"${ymd}" is not a YYYY-MM-DD date.`);
  }
  return { y, m, d };
}

/** Whole months between two YYYY-MM-DD dates (floor, calendar months). */
export function monthsBetween(fromYmd: string, toYmd: string): number {
  const f = parseYmd(fromYmd);
  const t = parseYmd(toYmd);
  let months = (t.y - f.y) * 12 + (t.m - f.m);
  if (t.d < f.d) months -= 1;
  return months;
}

/** Add whole calendar months to a YYYY-MM-DD date, clamping the day. */
export function addMonthsUtc(ymd: string, months: number): string {
  const { y, m, d } = parseYmd(ymd);
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}
