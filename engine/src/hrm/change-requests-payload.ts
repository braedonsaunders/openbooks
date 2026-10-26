import { canonicalNonNegativeDecimal } from "../money/exact-decimal.ts";
import { z } from "zod";
import { uuidString } from "../platform/uuid.ts";
import { makeEffectiveInterval, parseCivilDate } from "./temporal.ts";
import {
  profileChangePayloadSchema,
  type ProfileChangePayload,
} from "./self-service/profile-schema.ts";
import { bankChangePayloadSchema, type BankChangePayload } from "./self-service/bank-schema.ts";

/**
 * Governed HRM employment change-request service (slice A).
 *
 * Owns the 0185 proposal lifecycle (draft → pending_approval → approved →
 * applied, or rejected / withdrawn) and the all-or-nothing application of an
 * approved proposal onto the 0184 canonical record. Approval EXECUTION stays
 * native: decideGate drives the gates and the flows adapter's releaseApproval
 * calls back into releaseHrmChangeRequest here, inside the decide savepoint —
 * so a throw rolls the gate flip, the snapshot, and every canonical write
 * back together (DecisionFailedError contract in flows/gates.ts).
 *
 * Storage rules honored (never duplicated): the payload digest is computed
 * by the 0185 guard trigger — this service submits the payload and reads the
 * stored digest back, and never computes its own. Version closure follows
 * the 0184 close-then-insert-then-evidence order in ONE transaction with the
 * aggregate employment_changes event carrying exact before-images; the
 * deferred proof triggers verify successor adjacency and the same-transaction
 * txid stamp at commit.
 *
 * Authorization is hardwired to engine/src/hrm/authorization.ts — no caller
 * may supply parties, booleans, or scope. Writes run on the transaction
 * runner so each check and its write are atomic; every conditional write
 * asserts its affected row count (a zero-row write is a refusal, never a
 * success).
 */

/** Payload contract version stamped on every request of this slice. */
export const PAYLOAD_SCHEMA_VERSION = "1";

export type HrmChangeRequestCode =
  | "UNKNOWN_KIND"
  | "INVALID_PAYLOAD"
  | "NOT_FOUND"
  | "BAD_STATE"
  | "STALE_REVISION"
  | "NO_FLOW"
  | "FLOW_ERROR"
  | "REFUSED";

export class HrmChangeRequestError extends Error {
  readonly code: HrmChangeRequestCode;
  constructor(code: HrmChangeRequestCode, message: string) {
    super(message);
    this.name = "HrmChangeRequestError";
    this.code = code;
  }
}

/**
 * Canonical payload text for change detection: objects with recursively
 * sorted keys, so key order (which jsonb IS NOT DISTINCT FROM ignores)
 * never reads as an edit. An unchanged canonical payload is a touch, not
 * an edit — the revision stays put.
 */
export function canonicalPayloadText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayloadText).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPayloadText(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Walk the driver-error cause chain for a Postgres failure. */
function dbFault(error: unknown): { code?: string; message?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; message?: string; cause?: unknown };
    if (candidate.code !== undefined) return { code: candidate.code, message: candidate.message };
    current = candidate.cause;
  }
  return {};
}

/**
 * Guard-trigger refusals (P0001 raise_exception) arrive as driver errors —
 * map them to named domain refusals with the trigger's message (and remedy)
 * intact, never a 500 'internal error'.
 */
export function mapGuardRefusal(error: unknown): never {
  const fault = dbFault(error);
  if (
    typeof fault.message === "string" &&
    fault.code === "P0001" &&
    fault.message.startsWith("HRM change request")
  ) {
    throw new HrmChangeRequestError(
      /revision/i.test(fault.message) ? "STALE_REVISION" : "BAD_STATE",
      fault.message,
    );
  }
  throw error;
}

// --- Payload validation (zod; pure, unit-tested without a database) --------

const EMPLOYMENT_STATUSES = ["offered", "active", "on_leave", "suspended", "terminated"] as const;

const civilDate = (field: string) =>
  z.string().refine(
    (value) => {
      try {
        parseCivilDate(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: `${field} must be a real YYYY-MM-DD calendar date in years 0001 through 9999` },
  );

const uuidField = (field: string) => uuidString(`${field} must be a uuid`);

const fteField = z
  .string()
  .refine(
    (value) => canonicalNonNegativeDecimal(value, 4) !== null,
    "fte must be a decimal string with up to 4 fraction digits",
  )
  .refine(
    (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 && n < 1000;
    },
    { message: "fte must be greater than 0 and below 1000" },
  );

/**
 * The first assignment riding a hire: title, department, location, FTE and
 * primary plus the line manager and the establishment link, all effective
 * over the hire's own window. It is validated like an assignment change
 * (same field contract, same reference proofs) and applied atomically
 * with the hire in the same approval — one decision covers the whole
 * first-employment package. The establishment link rides along; pay,
 * tax, and roster schedules attach through their native surfaces once
 * the employment exists.
 */
const initialAssignmentSchema = z
  .object({
    assignmentKey: z.string().trim().min(1, "assignmentKey must not be blank").max(120),
    jobTitle: z.string().trim().min(1).max(240).nullable().optional(),
    departmentId: uuidField("departmentId").nullable().optional(),
    locationId: uuidField("locationId").nullable().optional(),
    fte: fteField.optional(),
    isPrimary: z.boolean().default(true),
    managerEmploymentId: uuidField("managerEmploymentId").nullable().optional(),
    positionId: uuidField("positionId").nullable().optional(),
  })
  .strict();

const hirePayloadSchema = z
  .object({
    kind: z.literal("hire"),
    status: z.enum(EMPLOYMENT_STATUSES).default("active"),
    effectiveFrom: civilDate("effectiveFrom"),
    effectiveTo: civilDate("effectiveTo").nullable().default(null),
    initialAssignment: initialAssignmentSchema.optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.status === "terminated") {
      ctx.addIssue({
        code: "custom",
        message:
          "a hire cannot carry status terminated — hire as offered or active, then file a termination",
      });
    }
    if (payload.initialAssignment?.managerEmploymentId === null) {
      ctx.addIssue({
        code: "custom",
        message:
          "manager removal is not modeled — a reporting line closes only onto a successor manager; file the hire without managerEmploymentId to leave reporting untouched",
      });
    }
    try {
      makeEffectiveInterval(payload.effectiveFrom, payload.effectiveTo);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const statusChangePayloadSchema = z
  .object({
    kind: z.literal("status_change"),
    status: z.enum(EMPLOYMENT_STATUSES),
    effectiveFrom: civilDate("effectiveFrom"),
    effectiveTo: civilDate("effectiveTo").nullable().default(null),
    historicalObservation: z
      .object({
        sourceReference: z.string().trim().min(1, "sourceReference must not be blank").max(2000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.historicalObservation && payload.effectiveTo === null) {
      ctx.addIssue({
        code: "custom",
        message: "a historical status observation needs an exclusive end date",
      });
    }
    // Ending employment is a termination: it ends benefit coverage and sets
    // the payroll termination date. A status change records only observed
    // historical windows of terminated status.
    if (payload.status === "terminated" && !payload.historicalObservation) {
      ctx.addIssue({
        code: "custom",
        message:
          "end employment with a termination change, which also ends benefit coverage and final pay; a terminated status change is only for a historical observation",
      });
    }
    try {
      makeEffectiveInterval(payload.effectiveFrom, payload.effectiveTo);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const assignmentChangePayloadSchema = z
  .object({
    kind: z.literal("assignment_change"),
    assignmentKey: z.string().trim().min(1, "assignmentKey must not be blank").max(120),
    jobTitle: z.string().trim().min(1).max(240).nullable().optional(),
    departmentId: uuidField("departmentId").nullable().optional(),
    locationId: uuidField("locationId").nullable().optional(),
    fte: fteField.optional(),
    isPrimary: z.boolean().optional(),
    effectiveFrom: civilDate("effectiveFrom").optional(),
    effectiveTo: civilDate("effectiveTo").nullable().optional(),
    managerEmploymentId: uuidField("managerEmploymentId").nullable().optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const carriesContent =
      payload.jobTitle !== undefined ||
      payload.departmentId !== undefined ||
      payload.locationId !== undefined ||
      payload.fte !== undefined ||
      payload.isPrimary !== undefined ||
      payload.managerEmploymentId !== undefined;
    if (!carriesContent) {
      ctx.addIssue({
        code: "custom",
        message:
          "an assignment change must set at least one of jobTitle, departmentId, locationId, fte, isPrimary, or managerEmploymentId — file a status change for a dates-only change",
      });
    }
    if (payload.managerEmploymentId === null) {
      ctx.addIssue({
        code: "custom",
        message:
          "manager removal is not modeled — a reporting line closes only onto a successor manager; file the change without managerEmploymentId to leave reporting untouched",
      });
    }
    if (payload.effectiveFrom !== undefined || payload.effectiveTo !== undefined) {
      try {
        makeEffectiveInterval(payload.effectiveFrom ?? "0001-01-01", payload.effectiveTo ?? null);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

const terminationPayloadSchema = z
  .object({
    kind: z.literal("termination"),
    effectiveDate: civilDate("effectiveDate"),
  })
  .strict();

/**
 * Employment-to-position assignment (0192). Carries ONLY the position link
 * (plus the window it takes effect on): title, department, location, FTE
 * and primary stay on the assignment version and are never rewritten here.
 * positionId null unassigns the slot. Disagreement with the position
 * version is a warning in evidence, never a rewrite.
 */
const positionAssignmentPayloadSchema = z
  .object({
    kind: z.literal("position_assignment"),
    assignmentKey: z.string().trim().min(1, "assignmentKey must not be blank").max(120),
    positionId: uuidField("positionId").nullable(),
    effectiveFrom: civilDate("effectiveFrom").optional(),
    effectiveTo: civilDate("effectiveTo").nullable().optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.effectiveFrom !== undefined || payload.effectiveTo !== undefined) {
      try {
        makeEffectiveInterval(payload.effectiveFrom ?? "0001-01-01", payload.effectiveTo ?? null);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

const CHANGE_KINDS = [
  "hire",
  "status_change",
  "assignment_change",
  "termination",
  "position_assignment",
  "profile_change",
  "bank_change",
] as const;

export type HirePayload = z.infer<typeof hirePayloadSchema>;
export type HireInitialAssignment = NonNullable<HirePayload["initialAssignment"]>;
export type StatusChangePayload = z.infer<typeof statusChangePayloadSchema>;
export type AssignmentChangePayload = z.infer<typeof assignmentChangePayloadSchema>;
export type TerminationPayload = z.infer<typeof terminationPayloadSchema>;
export type PositionAssignmentPayload = z.infer<typeof positionAssignmentPayloadSchema>;
export type BankDetailsChangePayload = BankChangePayload;
export type ChangeRequestPayload =
  | HirePayload
  | StatusChangePayload
  | AssignmentChangePayload
  | TerminationPayload
  | PositionAssignmentPayload
  | ProfileChangePayload
  | BankChangePayload;

function formatIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  return issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

/**
 * Validate a raw proposal payload. Refuses unknown kinds by name (listing
 * the governed kinds) and shapes every zod failure into one coded refusal
 * naming the offending fields.
 */
export function validateChangePayload(raw: unknown): ChangeRequestPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "change payload must be a JSON object with a kind — file one of hire, status_change, assignment_change, termination, position_assignment, profile_change, or bank_change",
    );
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (
    kind === undefined ||
    typeof kind !== "string" ||
    !(CHANGE_KINDS as readonly string[]).includes(kind)
  ) {
    throw new HrmChangeRequestError(
      "UNKNOWN_KIND",
      `unknown change kind ${JSON.stringify(kind)} — file one of hire, status_change, assignment_change, termination, position_assignment, profile_change, or bank_change`,
    );
  }
  if (kind === "profile_change") {
    // The self-service kind validates through its own contract (shared
    // leaf schema, no parallel validator): its failures name profile
    // fields, never employment ones.
    const parsed = profileChangePayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        `change payload invalid: ${formatIssues(parsed.error.issues)} — fix the profile fields and file again`,
      );
    }
    return parsed.data;
  }
  if (kind === "bank_change") {
    // The self-service bank kind validates through its own sealed
    // contract (shared leaf schema, no parallel validator): its failures
    // name bank fields, never employment ones. The account number travels
    // sealed — validation here never sees plaintext.
    const parsed = bankChangePayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        `change payload invalid: ${formatIssues(parsed.error.issues)} — fix the bank fields and file again`,
      );
    }
    return parsed.data;
  }
  const schema =
    kind === "hire"
      ? hirePayloadSchema
      : kind === "status_change"
        ? statusChangePayloadSchema
        : kind === "assignment_change"
          ? assignmentChangePayloadSchema
          : kind === "position_assignment"
            ? positionAssignmentPayloadSchema
            : terminationPayloadSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      `change payload invalid: ${formatIssues(parsed.error.issues)} — fix the payload fields and file again`,
    );
  }
  return parsed.data as ChangeRequestPayload;
}

// --- Request rows and DTOs ---------------------------------------------------
