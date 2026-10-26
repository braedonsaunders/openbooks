/** Shared HR process refusals, input guards and the feature gate. */
import { type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { HRM_FEATURE_KEY } from "./employment-read.ts";
import { ProcessMathError } from "./process-math.ts";
import { inputGuards } from "./input-guards.ts";

/**
 * Governed HRM onboarding / offboarding / transfer checklists.
 *
 * Templates are configuration; processes are snapshot history opened in the
 * SAME transaction as the approved change request that triggers them, so a
 * partial effect cannot exist. Every conditional write asserts its affected
 * row count — a zero-row write is a refusal, never a success — and every
 * refusal names its remedy. Writes run on the transaction runner so each
 * check and its write are atomic. The one authorization exception is
 * self-service: a step owner who is the employee themself may complete only
 * their own steps, fenced to the single step row.
 */

export type HrmProcessCode =
  | "NOT_FOUND"
  | "BAD_STATE"
  | "REFUSED"
  | "FORBIDDEN"
  | "TEMPLATE_NOT_FOUND"
  | "AMBIGUOUS_TEMPLATE"
  | "NO_LIVE_VERSION"
  | "DUPLICATE_OPEN"
  | "EVIDENCE_REQUIRED"
  | "UNREADABLE_ATTACHMENT"
  | "FEATURE_OFF";

export class HrmProcessError extends Error {
  readonly code: HrmProcessCode;
  constructor(code: HrmProcessCode, message: string) {
    super(message);
    this.name = "HrmProcessError";
    this.code = code;
  }
}

export type ProcessKind = "onboarding" | "offboarding" | "transfer";

const PROCESS_KINDS = ["onboarding", "offboarding", "transfer"] as const;

export function requireKind(kind: unknown): ProcessKind {
  if (typeof kind !== "string" || !(PROCESS_KINDS as readonly string[]).includes(kind)) {
    throw new HrmProcessError(
      "REFUSED",
      `unknown process kind ${JSON.stringify(kind)} — open one of onboarding, offboarding, or transfer`,
    );
  }
  return kind as ProcessKind;
}

export const { requireOrgId, requireActorId, requireId } = inputGuards(
  (message) => new HrmProcessError("REFUSED", message),
);

export function requireNonBlank(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HrmProcessError(
      "REFUSED",
      `${field} must be recorded — a reasonless checklist change is not evidence`,
    );
  }
  return value.trim();
}

/** Translate pure-math refusals without losing their message. */
export function mathRefusal(error: unknown, fallback: HrmProcessCode): never {
  if (error instanceof ProcessMathError) {
    throw new HrmProcessError(error.code as HrmProcessCode, error.message);
  }
  throw new HrmProcessError(fallback, error instanceof Error ? error.message : String(error));
}

export async function assertHrmFeatureOn(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmProcessError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before working with processes",
    );
  }
}
