import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import {
  checkApprovalIdentitySeparation,
  loadActorPerson,
  loadApprovalPerson,
  requireHrmEmploymentApprove,
  requireHrmEmploymentManage,
  requireHrmEmploymentRead,
} from "./authorization.ts";
import {
  HrmPositionError,
  positionDisagreements,
  recordPositionAssignmentEvent,
} from "./positions.ts";
import {
  intervalsOverlap,
  makeEffectiveInterval,
  NoRevisionError,
  parseCivilDate,
  resolveAsOf,
} from "./temporal.ts";
import { autoOpenProcessForChange, processTriggerForApply } from "./processes.ts";
import { endEnrollmentsForTermination } from "./benefits/enrollments.ts";

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

const uuidField = (field: string) => z.string().uuid(`${field} must be a uuid`);

const fteField = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "fte must be a decimal string with up to 4 fraction digits")
  .refine(
    (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 && n < 1000;
    },
    { message: "fte must be greater than 0 and below 1000" },
  );

const hirePayloadSchema = z
  .object({
    kind: z.literal("hire"),
    status: z.enum(EMPLOYMENT_STATUSES).default("active"),
    effectiveFrom: civilDate("effectiveFrom"),
    effectiveTo: civilDate("effectiveTo").nullable().default(null),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.status === "terminated") {
      ctx.addIssue({
        code: "custom",
        message: "a hire cannot carry status terminated — hire as offered or active, then file a termination",
      });
    }
    try {
      makeEffectiveInterval(payload.effectiveFrom, payload.effectiveTo);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    }
  });

const statusChangePayloadSchema = z
  .object({
    kind: z.literal("status_change"),
    status: z.enum(EMPLOYMENT_STATUSES),
    effectiveFrom: civilDate("effectiveFrom"),
    effectiveTo: civilDate("effectiveTo").nullable().default(null),
  })
  .strict()
  .superRefine((payload, ctx) => {
    try {
      makeEffectiveInterval(payload.effectiveFrom, payload.effectiveTo);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
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
        makeEffectiveInterval(
          payload.effectiveFrom ?? "0001-01-01",
          payload.effectiveTo ?? null,
        );
      } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
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
        makeEffectiveInterval(
          payload.effectiveFrom ?? "0001-01-01",
          payload.effectiveTo ?? null,
        );
      } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
      }
    }
  });

const CHANGE_KINDS = ["hire", "status_change", "assignment_change", "termination", "position_assignment"] as const;

export type HirePayload = z.infer<typeof hirePayloadSchema>;
export type StatusChangePayload = z.infer<typeof statusChangePayloadSchema>;
export type AssignmentChangePayload = z.infer<typeof assignmentChangePayloadSchema>;
export type TerminationPayload = z.infer<typeof terminationPayloadSchema>;
export type PositionAssignmentPayload = z.infer<typeof positionAssignmentPayloadSchema>;
export type ChangeRequestPayload =
  | HirePayload
  | StatusChangePayload
  | AssignmentChangePayload
  | TerminationPayload
  | PositionAssignmentPayload;

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message,
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
      "change payload must be a JSON object with a kind — file one of hire, status_change, assignment_change, termination, or position_assignment",
    );
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === undefined || typeof kind !== "string" || !(CHANGE_KINDS as readonly string[]).includes(kind)) {
    throw new HrmChangeRequestError(
      "UNKNOWN_KIND",
      `unknown change kind ${JSON.stringify(kind)} — file one of hire, status_change, assignment_change, termination, or position_assignment`,
    );
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

type RequestRow = {
  id: string;
  org_id: string;
  employment_id: string;
  request_revision: number;
  expected_employment_revision: number;
  payload: unknown;
  payload_digest: string;
  payload_schema_version: string;
  reason: string | null;
  status: string;
  submitted_by: string | null;
  submitted_at: Date | null;
  flow_run_id: string | null;
  decision_snapshot: Record<string, unknown> | null;
  applied_at: Date | null;
  applied_by: string | null;
  applied_employment_revision: number | null;
  applied_employment_change_id: string | null;
  created_at: Date;
  created_by: string | null;
  updated_at: Date;
  updated_by: string | null;
};

export interface ChangeRequestDTO {
  readonly id: string;
  readonly orgId: string;
  readonly employmentId: string;
  readonly requestRevision: number;
  readonly expectedEmploymentRevision: number;
  readonly payload: ChangeRequestPayload;
  readonly payloadDigest: string;
  readonly payloadSchemaVersion: string;
  readonly reason: string | null;
  readonly status: string;
  readonly submittedBy: string | null;
  readonly submittedAt: Date | null;
  readonly flowRunId: string | null;
  readonly decisionSnapshot: Record<string, unknown> | null;
  readonly appliedAt: Date | null;
  readonly appliedBy: string | null;
  readonly appliedEmploymentRevision: number | null;
  readonly appliedEmploymentChangeId: string | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

function toDTO(row: RequestRow): ChangeRequestDTO {
  return {
    id: row.id,
    orgId: row.org_id,
    employmentId: row.employment_id,
    requestRevision: row.request_revision,
    expectedEmploymentRevision: row.expected_employment_revision,
    payload: validateChangePayload(row.payload),
    payloadDigest: row.payload_digest,
    payloadSchemaVersion: row.payload_schema_version,
    reason: row.reason,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    flowRunId: row.flow_run_id,
    decisionSnapshot: row.decision_snapshot,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    appliedEmploymentRevision: row.applied_employment_revision,
    appliedEmploymentChangeId: row.applied_employment_change_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

const REQUEST_COLUMNS = sql`
  id, org_id, employment_id, request_revision, expected_employment_revision,
  payload, payload_digest, payload_schema_version, reason, status,
  submitted_by, submitted_at, flow_run_id, decision_snapshot,
  applied_at, applied_by, applied_employment_revision, applied_employment_change_id,
  created_at, created_by, updated_at, updated_by
`;

function requireOrgId(orgId: unknown): string {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new HrmChangeRequestError("REFUSED", "orgId must be a non-empty string");
  }
  return orgId;
}

function requireActorId(actorId: unknown): string {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new HrmChangeRequestError("REFUSED", "actorId must be a non-empty string");
  }
  return actorId;
}

function requireRequestId(requestId: unknown): string {
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new HrmChangeRequestError("REFUSED", "requestId must be a non-empty string");
  }
  return requestId;
}

function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "submission carries a non-blank reason — record why the change is proposed",
    );
  }
  return reason.trim();
}

async function loadRequestForUpdate(
  exec: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<RequestRow> {
  const rows = (await exec.execute<RequestRow>(sql`
    select ${REQUEST_COLUMNS} from hrm_employment_change_requests
     where org_id = ${orgId} and id = ${requestId} for update
  `)).rows;
  const row = rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization
  // (the org_id predicate is the org-isolation enforcement — never report
  // which of the two, so existence cannot be probed across tenants).
  if (!row) {
    throw new HrmChangeRequestError(
      "NOT_FOUND",
      "employment change request not found in this organization — check the request id",
    );
  }
  return row;
}

// --- Kind preconditions (fail fast at authoring and at submit) ---------------

type LiveEmploymentVersion = {
  id: string;
  version_no: number;
  status: string;
  effective_from: string;
  effective_to: string | null;
  before: unknown;
};

async function liveEmploymentVersions(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<LiveEmploymentVersion[]> {
  const rows = (await exec.execute<{
    id: string;
    version_no: number;
    status: string;
    effective_from: string;
    effective_to: string | null;
    before: unknown;
  }>(sql`
    select id, version_no, status,
           effective_from::text as effective_from,
           effective_to::text as effective_to,
           to_jsonb(worker_employment_versions) as before
      from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and recorded_until is null
     order by version_no
  `)).rows;
  return rows;
}

async function employmentVersionCount(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<number> {
  const rows = (await exec.execute<{ n: number }>(sql`
    select count(*)::int as n from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
  `)).rows;
  return rows[0]?.n ?? 0;
}

/**
 * Authoring-time preconditions per kind, re-checked at submit: a hire lands
 * only on a version-less (reserved) identity; every other kind needs an
 * existing effective version; a termination needs a non-terminated live
 * version. These are request-state checks — the apply re-derives everything
 * under the aggregate lock and refuses stale races there.
 */
async function assertKindPreconditions(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  payload: ChangeRequestPayload,
): Promise<void> {
  if (payload.kind === "hire") {
    const count = await employmentVersionCount(exec, orgId, employmentId);
    if (count > 0) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "this employment already has an effective version — file a status change, not a hire",
      );
    }
    return;
  }
  const live = await liveEmploymentVersions(exec, orgId, employmentId);
  if (live.length === 0) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "this employment has no effective version yet — file a hire before changing it",
    );
  }
  if (payload.kind === "termination" && live.every((version) => version.status === "terminated")) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "this employment is already terminated — a second termination is a duplicate, not an update",
    );
  }
  if (payload.kind === "position_assignment" && payload.positionId !== null) {
    const position = (await exec.execute(sql`
      select 1 as one from positions where org_id = ${orgId} and id = ${payload.positionId}
    `)).rows[0];
    if (!position) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the position is not visible in this organization — name a position of this organization",
      );
    }
  }
}

// --- Create / patch ----------------------------------------------------------

export interface CreateChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly payload: unknown;
}

/**
 * File a draft proposal. Binds the live aggregate revision read in this
 * transaction (floor 1 holds by construction: reserved identities sit at
 * revision 1). The storage trigger computes the digest; the stored row is
 * read back so the caller holds the digest the approval will bind.
 */
export async function createChangeRequestDraft(query: CreateChangeRequestQuery): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireRequestId(query.employmentId);
  const payload = validateChangePayload(query.payload);
  return withOrgTransaction(orgId, async () => {
    // Authority first: denial (including unknown/other-org employment)
    // reports uniformly through the authorization gate.
    const subject = await requireHrmEmploymentManage(db, orgId, actorId, employmentId);
    await assertKindPreconditions(db, orgId, employmentId, payload);
    // payload_digest is NOT NULL without a default, but the guard trigger
    // overwrites it on insert with the canonical sha256 — the 64-zero
    // placeholder never survives the trigger and is never read back.
    const inserted = (await db.execute<RequestRow>(sql`
      insert into hrm_employment_change_requests
        (org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version, created_by, updated_by)
      values (${orgId}, ${employmentId}, ${subject.revision},
              ${JSON.stringify(payload)}::jsonb,
              ${"0".repeat(64)}, ${PAYLOAD_SCHEMA_VERSION}, ${actorId}, ${actorId})
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!inserted) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the draft was not stored — no row was written; retry the request",
      );
    }
    if (!/^[0-9a-f]{64}$/.test(inserted.payload_digest)) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the stored digest is not storage-computed sha256 hex — the guard trigger did not run; refuse the draft",
      );
    }
    return toDTO(inserted);
  });
}

export interface UpdateChangeRequestPayloadQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly payload: unknown;
}

/** Edit a draft's frozen proposal (draft only; bumps request_revision by one). */
export async function updateChangeRequestPayload(
  query: UpdateChangeRequestPayloadQuery,
): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireRequestId(query.requestId);
  const payload = validateChangePayload(query.payload);
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    await requireHrmEmploymentManage(db, orgId, actorId, current.employment_id);
    if (current.status !== "draft") {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        `a ${current.status} request is frozen — file a new request for a revised proposal instead`,
      );
    }
    await assertKindPreconditions(db, orgId, current.employment_id, payload);
    // request_revision moves by exactly one with a draft edit; the digest is
    // recomputed by the guard trigger from the new payload.
    const updated = (await db.execute<RequestRow>(sql`
      update hrm_employment_change_requests
         set payload = ${JSON.stringify(payload)}::jsonb,
             payload_schema_version = ${PAYLOAD_SCHEMA_VERSION},
             request_revision = ${current.request_revision + 1},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId}
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the draft edit was not stored — no row was written; retry the request",
      );
    }
    return toDTO(updated);
  });
}

// --- Submit / withdraw --------------------------------------------------------

export interface SubmitChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly reason: unknown;
}

/**
 * Submit a draft for governed approval. Opens the native approval run
 * through the flows planning entrypoint (lazy import: the flows registry
 * loads this service's adapter, so a static import would cycle). A draft
 * whose proposal no enabled flow gates is refused with the configuration
 * remedy — never auto-approved. A flow that matched but errored fails
 * closed the same way, after its stray gates/runs are cancelled so nothing
 * dangling can later release the request.
 */
export async function submitChangeRequest(query: SubmitChangeRequestQuery): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireRequestId(query.requestId);
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    // The row lock serializes a double-click or replayed submit against the
    // status check and the run stamp below.
    const current = await loadRequestForUpdate(db, orgId, requestId);
    await requireHrmEmploymentManage(db, orgId, actorId, current.employment_id);
    if (current.status !== "draft") {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        `a ${current.status} request cannot be submitted — only drafts submit`,
      );
    }
    const payload = validateChangePayload(current.payload);
    await assertKindPreconditions(db, orgId, current.employment_id, payload);

    // Lazy: engine/src/flows/run.ts → registry → this service's adapter.
    const { runRecordFlows } = await import("../flows/run.ts");
    const flowResult = await runRecordFlows(
      { kind: "on_submit", source: "api" },
      HRM_CHANGE_REQUEST_SUBJECT_KIND,
      requestId,
      { orgId, userId: actorId },
    );
    const gatedRun = flowResult.runs.find((run) => run.gatesCreated > 0);
    if (flowResult.failed || !gatedRun) {
      const strayRunIds = flowResult.runs.map((run) => run.runId);
      if (strayRunIds.length > 0) {
        await db.execute(sql`
          update flow_gates set status = 'cancelled', updated_at = now()
           where run_id in (
             select jsonb_array_elements_text(${JSON.stringify(strayRunIds)}::jsonb)::uuid
           ) and org_id = ${orgId} and status in ('pending', 'escalated')
        `);
        await db.execute(sql`
          update flow_runs set status = 'cancelled', finished_at = now()
           where id in (
             select jsonb_array_elements_text(${JSON.stringify(strayRunIds)}::jsonb)::uuid
           ) and org_id = ${orgId} and status in ('running', 'waiting')
        `);
      }
      if (flowResult.failed) {
        throw new HrmChangeRequestError(
          "FLOW_ERROR",
          "approval routing failed for this change — fix the approval flow, then submit again",
        );
      }
      throw new HrmChangeRequestError(
        "NO_FLOW",
        "no enabled approval flow produced an approval gate for employment change requests — configure a flow for employment change requests before submitting",
      );
    }

    // Submission stamps land atomically with the run anchor; the 0185 guard
    // verifies the run is in this org, of the governed kind, and opened for
    // this request id.
    const submitted = (await db.execute<RequestRow>(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval',
             reason = ${reason},
             submitted_by = ${actorId}, submitted_at = now(),
             flow_run_id = ${gatedRun.runId},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'draft'
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!submitted) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "the request changed while submission was being recorded — reload it and submit again",
      );
    }
    return toDTO(submitted);
  });
}

export interface WithdrawChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  /** Why the proposal is being withdrawn — required; withdrawal of a pending
   * request revokes an in-flight approval other people are party to. */
  readonly reason: unknown;
}

/**
 * Withdraw a draft or a pending request. Terminal states never resurrect:
 * approved, applied, and rejected refuse; a withdrawn-while-pending request
 * keeps its submission evidence and its bound run is cancelled so no
 * dangling gate can later release it.
 */
export async function withdrawChangeRequest(
  query: WithdrawChangeRequestQuery,
): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireRequestId(query.requestId);
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    await requireHrmEmploymentManage(db, orgId, actorId, current.employment_id);
    if (current.status !== "draft" && current.status !== "pending_approval") {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        `a ${current.status} request is terminal — file a new request for a revised proposal instead`,
      );
    }
    if (current.status === "pending_approval" && current.flow_run_id) {
      await db.execute(sql`
        update flow_gates set status = 'cancelled', updated_at = now()
         where run_id = ${current.flow_run_id} and org_id = ${orgId}
           and status in ('pending', 'escalated')
      `);
      await db.execute(sql`
        update flow_runs set status = 'cancelled', finished_at = now()
         where id = ${current.flow_run_id} and org_id = ${orgId}
           and status in ('running', 'waiting')
      `);
    }
    const withdrawn = (await db.execute<RequestRow>(sql`
      update hrm_employment_change_requests
         set status = 'withdrawn', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId}
         and status in ('draft', 'pending_approval')
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!withdrawn) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "the request changed while withdrawal was being recorded — reload it and try again",
      );
    }
    // Audit evidence for the withdrawal itself: actor, before/after state,
    // the reason, and the run it revoked. The request row keeps its
    // submission stamps; this is the record of who took them out of play.
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'hrm_employment_change_requests', ${requestId}, 'update', ${JSON.stringify({
        event: "withdrawn",
        actor: { kind: "user", userId: actorId },
        before: { status: current.status },
        after: { status: "withdrawn" },
        reason,
        employmentId: current.employment_id,
        cancelledFlowRunId: current.status === "pending_approval" ? current.flow_run_id : null,
      })}::jsonb, ${actorId})
    `);
    return toDTO(withdrawn);
  });
}

// --- Reads (org-scoped, authorization-gated per row) --------------------------

export interface GetChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
}

/** Read one request; the employment read gate owns visibility. */
export async function getChangeRequest(query: GetChangeRequestQuery): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireRequestId(query.requestId);
  return withOrgTransaction(orgId, async () => {
    const rows = (await db.execute<RequestRow>(sql`
      select ${REQUEST_COLUMNS} from hrm_employment_change_requests
       where org_id = ${orgId} and id = ${requestId}
    `)).rows;
    const row = rows[0];
    if (!row) {
      throw new HrmChangeRequestError(
        "NOT_FOUND",
        "employment change request not found in this organization — check the request id",
      );
    }
    await requireHrmEmploymentRead(db, orgId, actorId, row.employment_id);
    return toDTO(row);
  });
}

export interface ListChangeRequestsQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId?: string;
  readonly status?: string;
  readonly limit?: number;
}

const LIST_STATUSES = ["draft", "pending_approval", "approved", "rejected", "withdrawn", "applied"] as const;

/**
 * List requests in this org (newest first). Every returned row passes the
 * employment read gate, so a caller sees only employments in their
 * organization and legal-entity scope.
 */
export async function listChangeRequests(query: ListChangeRequestsQuery): Promise<ChangeRequestDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (query.status !== undefined && !(LIST_STATUSES as readonly string[]).includes(query.status)) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      `unknown request status ${JSON.stringify(query.status)} — filter by one of ${LIST_STATUSES.join(", ")}`,
    );
  }
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new HrmChangeRequestError("INVALID_PAYLOAD", "limit must be an integer from 1 to 500");
  }
  return withOrgTransaction(orgId, async () => {
    const rows = (await db.execute<RequestRow>(sql`
      select ${REQUEST_COLUMNS} from hrm_employment_change_requests
       where org_id = ${orgId}
         ${query.employmentId ? sql`and employment_id = ${query.employmentId}` : sql``}
         ${query.status ? sql`and status = ${query.status}` : sql``}
       order by created_at desc, id desc
       limit ${limit}
    `)).rows;
    const visible: ChangeRequestDTO[] = [];
    for (const row of rows) {
      await requireHrmEmploymentRead(db, orgId, actorId, row.employment_id);
      visible.push(toDTO(row));
    }
    return visible;
  });
}

// --- Release: decide (flip + snapshot) and apply (canonical writes) ---------
//
// Called by the flows adapter's releaseApproval INSIDE the decide savepoint,
// so any throw rolls the gate flip, the decision snapshot, and every
// canonical write back together and the gate stays pending. A request that
// already left pending_approval is a no-op (idempotent release contract in
// flows/types.ts): the first resolution won and this retry changes nothing.

export interface ReleaseChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly outcome: "approved" | "rejected";
  readonly comment?: string | null;
}

export interface ReleaseChangeRequestResult {
  /** True when the request had already left pending_approval — nothing changed. */
  readonly noop: boolean;
  readonly request: ChangeRequestDTO;
}

type DecidedGate = {
  gate_id: string;
  decision: string;
  decided_by: string | null;
  on_behalf_of_user_id: string | null;
  decided_at: Date | null;
  comment: string | null;
};

async function decidedGatesOfRun(
  exec: SqlExecutor,
  orgId: string,
  runId: string,
): Promise<DecidedGate[]> {
  const rows = (await exec.execute<DecidedGate>(sql`
    select id as gate_id, status as decision, decided_by, on_behalf_of_user_id,
           decided_at, comment
      from flow_gates
     where org_id = ${orgId} and run_id = ${runId}
       and status in ('approved', 'rejected')
     order by decided_at, id
  `)).rows;
  return rows;
}

function buildDecisionSnapshot(args: {
  request: RequestRow;
  outcome: "approved" | "rejected";
  gates: readonly DecidedGate[];
}): Record<string, unknown> {
  return {
    outcome: args.outcome,
    payload_digest: args.request.payload_digest,
    payload_schema_version: args.request.payload_schema_version,
    expected_employment_revision: args.request.expected_employment_revision,
    flow_run_id: args.request.flow_run_id,
    gates: args.gates.map((gate) => ({
      gate_id: gate.gate_id,
      decision: gate.decision,
      decided_by: gate.decided_by,
      on_behalf_of_user_id: gate.on_behalf_of_user_id,
      decided_at: gate.decided_at instanceof Date ? gate.decided_at.toISOString() : gate.decided_at,
      comment: gate.comment,
    })),
  };
}

export async function releaseHrmChangeRequest(
  query: ReleaseChangeRequestQuery,
): Promise<ReleaseChangeRequestResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireRequestId(query.requestId);
  // withOrgTransaction joins the caller's ambient tenant transaction (the
  // decide savepoint) instead of opening a nested one, so everything below
  // commits or rolls back with the decision.
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    if (current.status !== "pending_approval") {
      return { noop: true, request: toDTO(current) };
    }
    if (!current.flow_run_id || !current.submitted_by) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this pending request carries no submission evidence — withdraw it and file a new request",
      );
    }
    // Permission/scope half over the trusted subject loaded in-transaction.
    const subject = await requireHrmEmploymentApprove(db, orgId, actorId, current.employment_id);
    // Identity half over trusted-DB-loaded parties. An approver with no
    // linked person cannot be separated from anyone, so the refusal names
    // the remedy: link the person in Admin → Users → Link person.
    const approver = await loadActorPerson(db, orgId, actorId);
    if (!approver.partyId) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "employment approval refused: the approver has no linked person — link the approver to a person in Admin → Users → Link person before they decide",
      );
    }
    const submitter = await loadApprovalPerson(db, orgId, current.submitted_by);
    checkApprovalIdentitySeparation({
      approver,
      submitter,
      subjectWorkerPartyId: subject.workerPartyId,
    });

    const gates = await decidedGatesOfRun(db, orgId, current.flow_run_id);
    const snapshot = buildDecisionSnapshot({
      request: current,
      outcome: query.outcome,
      gates,
    });
    const flipped = (await db.execute<RequestRow>(sql`
      update hrm_employment_change_requests
         set status = ${query.outcome},
             decision_snapshot = ${JSON.stringify(snapshot)}::jsonb,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'pending_approval'
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!flipped) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "the request changed while the decision was being recorded — reload it and decide again",
      );
    }
    if (query.outcome === "rejected") {
      return { noop: false, request: toDTO(flipped) };
    }
    await applyApprovedRequest(db, {
      orgId,
      actorId,
      request: flipped,
      payload: validateChangePayload(flipped.payload),
    });
    const applied = (await db.execute<RequestRow>(sql`
      select ${REQUEST_COLUMNS} from hrm_employment_change_requests
       where org_id = ${orgId} and id = ${requestId}
    `)).rows[0];
    if (!applied) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the applied request cannot be read back — the application wrote nothing observable; retry the decision",
      );
    }
    return { noop: false, request: toDTO(applied) };
  });
}

// --- Application: one transaction, all-or-nothing ----------------------------

type ClosureElement = {
  table: string;
  identity: string;
  version_no: number;
  row_id: string;
  before: unknown;
};

type AssignmentSlotVersion = {
  id: string;
  version_no: number;
  position_id: string | null;
  job_title: string | null;
  department_id: string | null;
  location_id: string | null;
  fte: string;
  is_primary: boolean;
  effective_from: string;
  effective_to: string | null;
  before: unknown;
};

/** Overlap on the half-open effective grid (temporal.ts owns the semantics). */
function effectiveOverlaps(
  row: { effective_from: string; effective_to: string | null },
  start: string,
  end: string | null,
): boolean {
  return intervalsOverlap(
    { start: parseCivilDate(row.effective_from), end: row.effective_to === null ? null : parseCivilDate(row.effective_to) },
    { start: parseCivilDate(start), end: end === null ? null : parseCivilDate(end) },
  );
}

async function applyApprovedRequest(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: ChangeRequestPayload;
  },
): Promise<void> {
  const { orgId, actorId, request, payload } = args;
  // Defer the closure-link FKs: the close-then-insert-then-evidence order
  // writes closed_by_change_id before its employment_changes event exists.
  // Every check still fires at commit — nothing is weakened, only ordered.
  await exec.execute(sql`
    set constraints worker_employment_versions_change_tenant_fkey,
                      employment_assignment_versions_change_tenant_fkey,
                      reporting_relationships_change_tenant_fkey deferred
  `);

  // (1) Re-read the aggregate under lock and refuse a stale proposal: the
  // live revision must still equal the authored expectation.
  const aggregate = (await exec.execute<{ revision: number }>(sql`
    select revision from worker_employments
     where org_id = ${orgId} and id = ${request.employment_id} for update
  `)).rows[0];
  if (!aggregate) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the employment is gone — withdraw this request; a proposal about a deleted aggregate never applies",
    );
  }
  if (aggregate.revision !== request.expected_employment_revision) {
    throw new HrmChangeRequestError(
      "STALE_REVISION",
      `the employment changed since this proposal was written (expected revision ${request.expected_employment_revision}, live revision ${aggregate.revision}) — file a new request against the current revision`,
    );
  }
  const newRevision = aggregate.revision + 1;
  // Graph row first: the 0184 reporting cycle guard bumps hrm_graph_revisions
  // itself and refuses when the row is missing, so the row must exist before
  // any branch below writes reporting. The bump also serializes concurrent
  // appliers on other employments of the same graph.
  await bumpGraphRevision(exec, orgId);
  // One clock for the handoff: every recorded_until closed here equals the
  // recorded_at of its successor (seamless, no gap or overlap).
  const nowRow = (await exec.execute<{ now: DbInstant; now_iso: string }>(sql`
    select now() as now,
           to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now_iso
  `)).rows[0];
  const recordedAt = nowRow?.now;
  const recordedAtIso = nowRow?.now_iso;
  if (!recordedAt || typeof recordedAtIso !== "string" || recordedAtIso.length === 0) {
    throw new HrmChangeRequestError("REFUSED", "the database clock is unreadable — retry the decision");
  }

  // (1) is the aggregate re-read above; (2) the version writes with their
  // employment_changes event and (3) the approved → applied flip with the
  // evidence link (single-fire: only a still-approved row moves) land inside
  // each branch below — all in this one transaction.
  if (payload.kind === "hire") {
    await applyHire(exec, { orgId, actorId, request, payload, newRevision, recordedAt });
  } else if (payload.kind === "status_change" || payload.kind === "termination") {
    await applyEmploymentVersionChange(exec, { orgId, actorId, request, payload, newRevision, recordedAt });
  } else if (payload.kind === "position_assignment") {
    await applyPositionAssignment(exec, { orgId, actorId, request, payload, newRevision, recordedAt, recordedAtIso });
  } else {
    await applyAssignmentChange(exec, { orgId, actorId, request, payload, newRevision, recordedAt });
  }
}

/**
 * (a) Hire: the first effective version on a version-less (reserved)
 * identity, evidenced as a non-closure 'created' event.
 */
async function applyHire(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: HirePayload;
    newRevision: number;
    recordedAt: DbInstant;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt } = args;
  const count = await employmentVersionCount(exec, orgId, request.employment_id);
  if (count > 0) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "an effective version landed while this hire awaited approval — file a status change, not a second hire",
    );
  }
  await exec.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to,
       recorded_at, created_by, updated_by)
    values (${orgId}, ${request.employment_id}, 1, ${payload.status},
            ${payload.effectiveFrom}::date, ${payload.effectiveTo}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: null,
    revision: newRevision,
    changeKind: "created",
    priorSnapshot: {},
    closedVersions: [],
    reason: request.reason ?? "",
    actorId,
  });
  // The hire owes its onboarding checklist in this same transaction: a throw
  // (no template, duplicate open) rolls the version back with it, so a hire
  // without its checklist cannot exist while hrm is on. No-op while hrm is
  // off (payroll stays independent of the checklist module).
  const hireTrigger = processTriggerForApply({ kind: "hire", effectiveFrom: payload.effectiveFrom });
  if (hireTrigger !== null) {
    await autoOpenProcessForChange(exec, {
      orgId,
      actorId,
      employmentId: request.employment_id,
      changeId,
      trigger: hireTrigger,
    });
  }
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, { orgId, actorId, request, expected: newRevision - 1, next: newRevision });
}

/**
 * (b)/(d) Status/dates change and termination: close every live version
 * overlapping the successor window (close-first, per the 0184 write order),
 * insert the single successor, and evidence every closure with its exact
 * before-image in one aggregate event.
 */
async function applyEmploymentVersionChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: StatusChangePayload | TerminationPayload;
    newRevision: number;
    recordedAt: DbInstant;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt } = args;
  const successorStatus = payload.kind === "termination" ? "terminated" : payload.status;
  const windowStart = payload.kind === "termination" ? payload.effectiveDate : payload.effectiveFrom;
  const windowEnd = payload.kind === "termination" ? null : payload.effectiveTo;
  const live = await liveEmploymentVersions(exec, orgId, request.employment_id);
  const overlapping = live.filter((version) => effectiveOverlaps(version, windowStart, windowEnd));
  if (overlapping.length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "no live employment version overlaps the change window — reload the employment and file a new request",
    );
  }
  if (
    overlapping.length === 1 &&
    overlapping[0]!.status === successorStatus &&
    overlapping[0]!.effective_from === windowStart &&
    (overlapping[0]!.effective_to ?? null) === windowEnd
  ) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "the proposal changes nothing — file a new request only when status or dates actually change",
    );
  }
  if (payload.kind === "termination" && overlapping.every((version) => version.status === "terminated")) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "this employment is already terminated — a second termination is a duplicate, not an update",
    );
  }
  const successorNo = Math.max(...overlapping.map((version) => version.version_no)) + 1;
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: null,
    revision: newRevision,
    changeKind: payload.kind === "termination" ? "terminated" : "status_changed",
    priorSnapshot: {
      closed: overlapping.map((version) => ({
        versionNo: version.version_no,
        status: version.status,
        effectiveFrom: version.effective_from,
        effectiveTo: version.effective_to,
      })),
    },
    closedVersions: overlapping.map((version) => ({
      table: "worker_employment_versions",
      identity: request.employment_id,
      version_no: version.version_no,
      row_id: version.id,
      before: version.before,
    })),
    reason: request.reason ?? "",
    actorId,
  });
  for (const version of overlapping) {
    const closed = (await exec.execute(sql`
      update worker_employment_versions
         set recorded_until = ${recordedAt}, superseded_by = ${successorNo},
             closed_by_change_id = ${changeId}
       where org_id = ${orgId} and id = ${version.id} and recorded_until is null
      returning id
    `)).rows;
    if (closed.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "an employment version changed while the approval was applying — retry the decision",
      );
    }
  }
  await exec.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to,
       recorded_at, created_by, updated_by)
    values (${orgId}, ${request.employment_id}, ${successorNo}, ${successorStatus},
            ${windowStart}::date, ${windowEnd}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  // A termination owes its offboarding checklist in this same transaction
  // (same all-or-nothing contract as the hire above). A status_change rides
  // the hire's onboarding episode — it opens nothing on its own.
  const versionTrigger = processTriggerForApply(
    payload.kind === "termination"
      ? { kind: "termination", effectiveDate: payload.effectiveDate }
      : { kind: "status_change" },
  );
  if (versionTrigger !== null) {
    await autoOpenProcessForChange(exec, {
      orgId,
      actorId,
      employmentId: request.employment_id,
      changeId,
      trigger: versionTrigger,
    });
  }
  // A termination ends every live benefit enrolment in this same
  // transaction (HR-8): coverage cannot outlive the employment, and the
  // ends-or-cancels land atomically with the version successor above — a
  // throw rolls all of it back together.
  if (payload.kind === "termination") {
    await endEnrollmentsForTermination(exec, {
      orgId,
      actorId,
      employmentId: request.employment_id,
      terminatedOn: parseCivilDate(payload.effectiveDate),
    });
  }
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, { orgId, actorId, request, expected: newRevision - 1, next: newRevision });
}

/**
 * (c) Assignment change: department / location / job title / FTE / primary /
 * manager as 0184 models them. A first version on a new slot is evidenced
 * as 'assignment_issued'; closing live versions onto a successor is
 * 'assignment_superseded'. A manager repoint additionally closes the live
 * line reporting row onto its successor in the SAME aggregate event.
 */
async function applyAssignmentChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: AssignmentChangePayload;
    newRevision: number;
    recordedAt: DbInstant;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt } = args;
  await assertAssignmentRefs(exec, { orgId, employmentId: request.employment_id, payload });

  const slotRows = (await exec.execute<{ id: string }>(sql`
    select id from employment_assignments
     where org_id = ${orgId} and employment_id = ${request.employment_id}
       and assignment_key = ${payload.assignmentKey}
  `)).rows;
  const slotId = slotRows[0]?.id ?? null;

  if (slotId === null) {
    await issueAssignmentSlot(exec, { orgId, actorId, request, payload, newRevision, recordedAt });
    return;
  }

  const live = await liveAssignmentVersions(exec, orgId, slotId);
  // Successor window: explicit when given, otherwise carried from the single
  // live slice. Several live slices with no explicit window is ambiguous —
  // the proposal must name the window it changes.
  let windowStart: string;
  let windowEnd: string | null;
  if (payload.effectiveFrom !== undefined || payload.effectiveTo !== undefined) {
    if (live.length === 0) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this assignment has no live version to re-date — withdraw this request and file for the recorded slot state",
      );
    }
    const base = live.reduce((a, b) => (a.version_no > b.version_no ? a : b));
    windowStart = payload.effectiveFrom ?? base.effective_from;
    windowEnd = payload.effectiveTo ?? base.effective_to;
    makeEffectiveInterval(windowStart, windowEnd);
  } else {
    if (live.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this assignment holds several live slices and the proposal names no effective window — name effectiveFrom/effectiveTo explicitly",
      );
    }
    windowStart = live[0]!.effective_from;
    windowEnd = live[0]!.effective_to;
  }
  const overlapping = live.filter((version) => effectiveOverlaps(version, windowStart, windowEnd));
  if (overlapping.length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "no live assignment version overlaps the change window — reload the assignment and file a new request",
    );
  }
  // Content carry-over comes from the newest overlapping slice — including
  // the position link (0192): an assignment change never moves the holder
  // off its establishment; only a position_assignment request does that.
  const base = overlapping.reduce((a, b) => (a.version_no > b.version_no ? a : b));
  const successor = {
    positionId: base.position_id,
    jobTitle: payload.jobTitle !== undefined ? payload.jobTitle : base.job_title,
    departmentId: payload.departmentId !== undefined ? payload.departmentId : base.department_id,
    locationId: payload.locationId !== undefined ? payload.locationId : base.location_id,
    fte: payload.fte ?? base.fte,
    isPrimary: payload.isPrimary ?? base.is_primary,
  };
  if (
    overlapping.length === 1 &&
    overlapping[0]!.job_title === successor.jobTitle &&
    overlapping[0]!.department_id === successor.departmentId &&
    overlapping[0]!.location_id === successor.locationId &&
    overlapping[0]!.fte === successor.fte &&
    overlapping[0]!.is_primary === successor.isPrimary &&
    overlapping[0]!.effective_from === windowStart &&
    (overlapping[0]!.effective_to ?? null) === windowEnd &&
    payload.managerEmploymentId === undefined
  ) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "the proposal changes nothing — file a new request only when assignment content, dates, or manager actually change",
    );
  }
  await assertNoPrimaryConflict(exec, {
    orgId,
    employmentId: request.employment_id,
    slotId,
    isPrimary: successor.isPrimary,
    windowStart,
    windowEnd,
  });
  const successorNo = Math.max(...live.map((version) => version.version_no)) + 1;

  // Two-phase reporting: plan the closure evidence first (the event must
  // name it), then close and insert after the event exists.
  const reporting = await planLineManagerChange(exec, {
    orgId,
    employmentId: request.employment_id,
    managerId: payload.managerEmploymentId,
    windowStart,
    windowEnd,
  });
  const reportingElements = reporting.change ? reporting.elements : [];
  const closedVersions: ClosureElement[] = [
    ...overlapping.map((version) => ({
      table: "employment_assignment_versions",
      identity: slotId,
      version_no: version.version_no,
      row_id: version.id,
      before: version.before,
    })),
    ...reportingElements,
  ];
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: slotId,
    revision: newRevision,
    changeKind: "assignment_superseded",
    priorSnapshot: {
      slot: payload.assignmentKey,
      closed: overlapping.map((version) => ({
        versionNo: version.version_no,
        jobTitle: version.job_title,
        departmentId: version.department_id,
        locationId: version.location_id,
        fte: version.fte,
        isPrimary: version.is_primary,
        effectiveFrom: version.effective_from,
        effectiveTo: version.effective_to,
      })),
    },
    closedVersions,
    reason: request.reason ?? "",
    actorId,
  });
  for (const version of overlapping) {
    const closed = (await exec.execute(sql`
      update employment_assignment_versions
         set recorded_until = ${recordedAt}, superseded_by = ${successorNo},
             closed_by_change_id = ${changeId}
       where org_id = ${orgId} and id = ${version.id} and recorded_until is null
      returning id
    `)).rows;
    if (closed.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "an assignment version changed while the approval was applying — retry the decision",
      );
    }
  }
  await exec.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, position_id, version_no, job_title, department_id,
       location_id, fte, is_primary, effective_from, effective_to,
       recorded_at, created_by, updated_by)
    values (${orgId}, ${slotId}, ${request.employment_id}, ${successor.positionId}, ${successorNo},
            ${successor.jobTitle}, ${successor.departmentId}, ${successor.locationId},
            ${successor.fte}, ${successor.isPrimary},
            ${windowStart}::date, ${windowEnd}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  await closeLineManagerChange(exec, { orgId, actorId, request, reporting, changeId, recordedAt });
  // A real department move owes its transfer checklist in this same
  // transaction. A new slot ('assignment_issued' below) is not a move, and
  // neither is a repoint that carries the department over unchanged.
  const assignmentTrigger = processTriggerForApply({
    kind: "assignment_change",
    departmentChanged:
      payload.departmentId !== undefined &&
      (successor.departmentId ?? null) !== (base.department_id ?? null),
    windowStart,
  });
  if (assignmentTrigger !== null) {
    await autoOpenProcessForChange(exec, {
      orgId,
      actorId,
      employmentId: request.employment_id,
      changeId,
      trigger: assignmentTrigger,
    });
  }
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, { orgId, actorId, request, expected: newRevision - 1, next: newRevision });
}

/**
 * (e) Position assignment (0192): move an assignment slot onto a funded
 * position (or off it, when positionId is null). Only the position link
 * moves — title, department, location, FTE and primary carry over from the
 * newest overlapping slice, and disagreement with the position version is
 * recorded as a warning in BOTH ledgers' evidence (employment_changes
 * prior_snapshot and the position_changes 'assigned' event), never applied
 * as a rewrite.
 *
 * Evidenced as 'assignment_superseded' ('assignment_issued' on a new slot):
 * the employment_changes change_kind vocabulary is unchanged. The position
 * side is evidenced by recordPositionAssignmentEvent in the same
 * transaction. The target position row locks BEFORE any assignment write
 * (and closePosition locks the same row before its held-check), so a close
 * racing this application cannot miss the new holder.
 */
async function applyPositionAssignment(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: PositionAssignmentPayload;
    newRevision: number;
    recordedAt: DbInstant;
    /** The same clock as recordedAt, as a UTC ISO instant for as-of reads. */
    recordedAtIso: string;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt, recordedAtIso } = args;
  // Lock the target position first (when there is one): the revision read
  // here feeds the position-side event, and the row lock serializes against
  // concurrent closes and assignments on the same establishment.
  let target: { id: string; position_code: string; revision: number } | null = null;
  if (payload.positionId !== null) {
    const found = (await exec.execute<{ id: string; position_code: string; revision: number }>(sql`
      select id, position_code, revision from positions
       where org_id = ${orgId} and id = ${payload.positionId} for update
    `)).rows[0];
    if (!found) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the position is gone — withdraw this request; a proposal about a deleted establishment never applies",
      );
    }
    target = found;
  }

  const slotRows = (await exec.execute<{ id: string }>(sql`
    select id from employment_assignments
     where org_id = ${orgId} and employment_id = ${request.employment_id}
       and assignment_key = ${payload.assignmentKey}
  `)).rows;
  const slotId = slotRows[0]?.id ?? null;

  if (slotId === null) {
    if (payload.effectiveFrom === undefined) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "a new assignment needs effectiveFrom — name the date the slot takes effect",
      );
    }
    const windowStart = payload.effectiveFrom;
    const windowEnd = payload.effectiveTo ?? null;
    makeEffectiveInterval(windowStart, windowEnd);
    await assertNoPrimaryConflict(exec, {
      orgId,
      employmentId: request.employment_id,
      slotId: null,
      isPrimary: false,
      windowStart,
      windowEnd,
    });
    const issuedId = (await exec.execute<{ id: string }>(sql`
      insert into employment_assignments (org_id, employment_id, assignment_key, created_by, updated_by)
      values (${orgId}, ${request.employment_id}, ${payload.assignmentKey}, ${actorId}, ${actorId})
      returning id
    `)).rows[0]?.id;
    if (!issuedId) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the assignment slot was not stored — nothing applied; retry the decision",
      );
    }
    await exec.execute(sql`
      insert into employment_assignment_versions
        (org_id, assignment_id, employment_id, position_id, version_no,
         job_title, department_id, location_id, fte, is_primary,
         effective_from, effective_to, recorded_at, created_by, updated_by)
      values (${orgId}, ${issuedId}, ${request.employment_id}, ${payload.positionId}, 1,
              null, null, null, '1', false,
              ${windowStart}::date, ${windowEnd}::date,
              ${recordedAt}, ${actorId}, ${actorId})
    `);
    const warnings = await positionLinkWarnings(exec, {
      orgId,
      target,
      windowStart,
      asKnown: recordedAtIso,
      assignment: { title: null, departmentId: null, locationId: null },
    });
    const changeId = await insertEmploymentChange(exec, {
      orgId,
      employmentId: request.employment_id,
      assignmentId: issuedId,
      revision: newRevision,
      changeKind: "assignment_issued",
      priorSnapshot: {
        slot: payload.assignmentKey,
        issued: true,
        positionId: payload.positionId,
        positionWarnings: warnings,
      },
      closedVersions: [],
      reason: request.reason ?? "",
      actorId,
    });
    await recordPositionAssignmentEvent(exec, {
      orgId,
      actorId,
      positionId: payload.positionId,
      employmentId: request.employment_id,
      assignmentKey: payload.assignmentKey,
      priorPositionId: null,
      disagreementWarnings: warnings,
      reason: request.reason ?? "",
      positionRevision: target?.revision ?? 0,
    });
    await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
    await bumpAggregateRevision(exec, { orgId, actorId, request, expected: newRevision - 1, next: newRevision });
    return;
  }

  const live = await liveAssignmentVersions(exec, orgId, slotId);
  let windowStart: string;
  let windowEnd: string | null;
  if (payload.effectiveFrom !== undefined || payload.effectiveTo !== undefined) {
    if (live.length === 0) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this assignment has no live version to re-date — withdraw this request and file for the recorded slot state",
      );
    }
    const base = live.reduce((a, b) => (a.version_no > b.version_no ? a : b));
    windowStart = payload.effectiveFrom ?? base.effective_from;
    windowEnd = payload.effectiveTo ?? base.effective_to;
    makeEffectiveInterval(windowStart, windowEnd);
  } else {
    if (live.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this assignment holds several live slices and the proposal names no effective window — name effectiveFrom/effectiveTo explicitly",
      );
    }
    windowStart = live[0]!.effective_from;
    windowEnd = live[0]!.effective_to;
  }
  const overlapping = live.filter((version) => effectiveOverlaps(version, windowStart, windowEnd));
  if (overlapping.length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "no live assignment version overlaps the change window — reload the assignment and file a new request",
    );
  }
  const base = overlapping.reduce((a, b) => (a.version_no > b.version_no ? a : b));
  if (payload.positionId === null && base.position_id === null) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "this assignment names no position — an unassignment changes nothing; file a new request only when the position link actually changes",
    );
  }
  if (
    overlapping.length === 1 &&
    (overlapping[0]!.position_id ?? null) === payload.positionId &&
    overlapping[0]!.effective_from === windowStart &&
    (overlapping[0]!.effective_to ?? null) === windowEnd
  ) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "the proposal changes nothing — file a new request only when the position link or dates actually change",
    );
  }
  await assertNoPrimaryConflict(exec, {
    orgId,
    employmentId: request.employment_id,
    slotId,
    isPrimary: base.is_primary,
    windowStart,
    windowEnd,
  });
  const successorNo = Math.max(...live.map((version) => version.version_no)) + 1;
  const warnings = await positionLinkWarnings(exec, {
    orgId,
    target,
    windowStart,
    asKnown: recordedAtIso,
    assignment: { title: base.job_title, departmentId: base.department_id, locationId: base.location_id },
  });
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: slotId,
    revision: newRevision,
    changeKind: "assignment_superseded",
    priorSnapshot: {
      slot: payload.assignmentKey,
      priorPositionId: base.position_id,
      positionId: payload.positionId,
      positionWarnings: warnings,
      closed: overlapping.map((version) => ({
        versionNo: version.version_no,
        positionId: version.position_id,
        effectiveFrom: version.effective_from,
        effectiveTo: version.effective_to,
      })),
    },
    closedVersions: overlapping.map((version) => ({
      table: "employment_assignment_versions",
      identity: slotId,
      version_no: version.version_no,
      row_id: version.id,
      before: version.before,
    })),
    reason: request.reason ?? "",
    actorId,
  });
  for (const version of overlapping) {
    const closed = (await exec.execute(sql`
      update employment_assignment_versions
         set recorded_until = ${recordedAt}, superseded_by = ${successorNo},
             closed_by_change_id = ${changeId}
       where org_id = ${orgId} and id = ${version.id} and recorded_until is null
      returning id
    `)).rows;
    if (closed.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "an assignment version changed while the approval was applying — retry the decision",
      );
    }
  }
  await exec.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, position_id, version_no,
       job_title, department_id, location_id, fte, is_primary,
       effective_from, effective_to, recorded_at, created_by, updated_by)
    values (${orgId}, ${slotId}, ${request.employment_id}, ${payload.positionId}, ${successorNo},
            ${base.job_title}, ${base.department_id}, ${base.location_id},
            ${base.fte}, ${base.is_primary},
            ${windowStart}::date, ${windowEnd}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  await recordPositionAssignmentEvent(exec, {
    orgId,
    actorId,
    positionId: payload.positionId,
    employmentId: request.employment_id,
    assignmentKey: payload.assignmentKey,
    priorPositionId: base.position_id,
    disagreementWarnings: warnings,
    reason: request.reason ?? "",
    positionRevision: target?.revision ?? 0,
  });
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, { orgId, actorId, request, expected: newRevision - 1, next: newRevision });
}

/**
 * No-silent-inheritance preflight for a position link: compare the carried
 * assignment content against the target position's version as of the
 * successor window start. A position covering no version at that date
 * warns (the link still applies); an ambiguous position chain propagates
 * and fails the whole application. Position-side errors arrive as
 * HrmPositionError and are rehomed here so the change-request boundary
 * speaks one error type with the message intact.
 */
/**
 * The database clock as the driver hands it back: timestamptz arrives as
 * TEXT in this codebase, not a Date. It is bound straight back into SQL for
 * every recorded_at / recorded_until write (one clock, one value) and never
 * has Date methods called on it; a caller that needs an ISO instant takes
 * the to_char text selected beside it (recordedAtIso). Typing this as Date
 * once let `.toISOString()` reach runtime on an approval and fail with a
 * remedy that said "retry".
 */
type DbInstant = Date | string;

async function positionLinkWarnings(
  exec: SqlExecutor,
  args: {
    orgId: string;
    target: { id: string; position_code: string; revision: number } | null;
    windowStart: string;
    /** UTC ISO instant of the application clock (recordedAtIso), never the raw driver value. */
    asKnown: string;
    assignment: { title: string | null; departmentId: string | null; locationId: string | null };
  },
): Promise<string[]> {
  if (args.target === null) return [];
  try {
    const versions = (await exec.execute<{
      title: string;
      department_id: string | null;
      location_id: string | null;
      effective_from: string;
      effective_to: string | null;
      recorded_at: string;
      recorded_until: string | null;
    }>(sql`
      select title, department_id::text as department_id, location_id::text as location_id,
             effective_from::text as effective_from,
             effective_to::text as effective_to,
             to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
             to_char(recorded_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_until
        from position_versions
       where org_id = ${args.orgId} and position_id = ${args.target.id}
         and recorded_until is null
       order by version_no
    `)).rows;
    // resolveAsOf, NoRevisionError and parseCivilDate are the static
    // temporal imports at the top of this file — the same primitives the
    // employment paths resolve through.
    let covered;
    try {
      covered = resolveAsOf(
        versions.map((row) => ({
          effective: {
            start: parseCivilDate(row.effective_from),
            end: row.effective_to === null ? null : parseCivilDate(row.effective_to),
          },
          recordedAt: row.recorded_at,
          recordedUntil: row.recorded_until,
          payload: row,
        })),
        { effective: args.windowStart, asKnown: args.asKnown },
      );
    } catch (resolveError) {
      if (resolveError instanceof NoRevisionError) {
        return [
          `position ${args.target.position_code} covers no version at ${args.windowStart} — the assignment keeps its own title, department and location`,
        ];
      }
      throw resolveError;
    }
    return positionDisagreements(
      args.target.position_code,
      {
        title: covered.payload.title,
        departmentId: covered.payload.department_id,
        locationId: covered.payload.location_id,
      },
      args.assignment,
    );
  } catch (error) {
    if (error instanceof HrmPositionError) {
      throw new HrmChangeRequestError("REFUSED", error.message);
    }
    throw error;
  }
}

/** First version on a brand-new slot ('assignment_issued', no closures). */
async function issueAssignmentSlot(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: AssignmentChangePayload;
    newRevision: number;
    recordedAt: DbInstant;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt } = args;
  if (payload.effectiveFrom === undefined) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "a new assignment needs effectiveFrom — name the date the slot takes effect",
    );
  }
  const windowStart = payload.effectiveFrom;
  const windowEnd = payload.effectiveTo ?? null;
  makeEffectiveInterval(windowStart, windowEnd);
  const isPrimary = payload.isPrimary ?? false;
  await assertNoPrimaryConflict(exec, {
    orgId,
    employmentId: request.employment_id,
    slotId: null,
    isPrimary,
    windowStart,
    windowEnd,
  });
  const slotId = (await exec.execute<{ id: string }>(sql`
    insert into employment_assignments (org_id, employment_id, assignment_key, created_by, updated_by)
    values (${orgId}, ${request.employment_id}, ${payload.assignmentKey}, ${actorId}, ${actorId})
    returning id
  `)).rows[0]?.id;
  if (!slotId) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the assignment slot was not stored — nothing applied; retry the decision",
    );
  }
  await exec.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, version_no, job_title, department_id,
       location_id, fte, is_primary, effective_from, effective_to,
       recorded_at, created_by, updated_by)
    values (${orgId}, ${slotId}, ${request.employment_id}, 1,
            ${payload.jobTitle ?? null}, ${payload.departmentId ?? null}, ${payload.locationId ?? null},
            ${payload.fte ?? "1"}, ${isPrimary},
            ${windowStart}::date, ${windowEnd}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  const reporting = await planLineManagerChange(exec, {
    orgId,
    employmentId: request.employment_id,
    managerId: payload.managerEmploymentId,
    windowStart,
    windowEnd,
  });
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: slotId,
    revision: newRevision,
    changeKind: "assignment_issued",
    priorSnapshot: { slot: payload.assignmentKey, issued: true },
    closedVersions: reporting.change ? reporting.elements : [],
    reason: request.reason ?? "",
    actorId,
  });
  await closeLineManagerChange(exec, { orgId, actorId, request, reporting, changeId, recordedAt });
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, { orgId, actorId, request, expected: newRevision - 1, next: newRevision });
}

async function liveAssignmentVersions(
  exec: SqlExecutor,
  orgId: string,
  slotId: string,
): Promise<AssignmentSlotVersion[]> {
  const rows = (await exec.execute<AssignmentSlotVersion & { before: unknown }>(sql`
    select id, version_no, position_id::text as position_id,
           job_title, department_id, location_id, fte::text as fte,
           is_primary, effective_from::text as effective_from,
           effective_to::text as effective_to,
           to_jsonb(employment_assignment_versions) as before
      from employment_assignment_versions
     where org_id = ${orgId} and assignment_id = ${slotId}
       and recorded_until is null
     order by version_no
  `)).rows;
  return rows;
}

/**
 * Prove foreign references before writing: a department, location, or
 * manager from another organization (or a typo) is refused with the field
 * named — never left to a raw constraint violation. A manager must also be
 * a real employment and never the subject itself.
 */
async function assertAssignmentRefs(
  exec: SqlExecutor,
  args: { orgId: string; employmentId: string; payload: AssignmentChangePayload },
): Promise<void> {
  const { orgId, employmentId, payload } = args;
  if (payload.departmentId) {
    const found = (await exec.execute(sql`
      select 1 as one from departments where org_id = ${orgId} and id = ${payload.departmentId}
    `)).rows[0];
    if (!found) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the department is not visible in this organization — pick a department of this organization",
      );
    }
  }
  if (payload.locationId) {
    const found = (await exec.execute(sql`
      select 1 as one from locations where org_id = ${orgId} and id = ${payload.locationId}
    `)).rows[0];
    if (!found) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the location is not visible in this organization — pick a location of this organization",
      );
    }
  }
  if (payload.managerEmploymentId !== undefined && payload.managerEmploymentId !== null) {
    if (payload.managerEmploymentId === employmentId) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "an employment cannot report to itself — name another employment as manager",
      );
    }
    const found = (await exec.execute(sql`
      select 1 as one from worker_employments where org_id = ${orgId} and id = ${payload.managerEmploymentId}
    `)).rows[0];
    if (!found) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the manager employment is not visible in this organization — name an employment of this organization",
      );
    }
  }
}

/**
 * Single-primary invariant, checked before writing: a primary successor
 * overlapping another slot's live primary in both dimensions is refused by
 * name instead of tripping the deferred exclusion at commit.
 */
async function assertNoPrimaryConflict(
  exec: SqlExecutor,
  args: {
    orgId: string;
    employmentId: string;
    slotId: string | null;
    isPrimary: boolean;
    windowStart: string;
    windowEnd: string | null;
  },
): Promise<void> {
  if (!args.isPrimary) return;
  const rows = (await exec.execute<{ assignment_key: string }>(sql`
    select a.assignment_key
      from employment_assignment_versions av
      join employment_assignments a on a.id = av.assignment_id and a.org_id = av.org_id
     where av.org_id = ${args.orgId} and av.employment_id = ${args.employmentId}
       ${args.slotId === null ? sql`` : sql`and av.assignment_id <> ${args.slotId}`}
       and av.is_primary and av.recorded_until is null
       and daterange(av.effective_from, coalesce(av.effective_to, 'infinity'::date), '[)')
           && daterange(${args.windowStart}::date, coalesce(${args.windowEnd}::date, 'infinity'::date), '[)')
     limit 1
  `)).rows;
  const clash = rows[0];
  if (clash) {
    throw new HrmChangeRequestError(
      "REFUSED",
      `assignment ${clash.assignment_key} is already primary over that window — at most one assignment may be primary at one as-of point`,
    );
  }
}

type LiveLineRelationship = {
  id: string;
  relationship_id: string;
  version_no: number;
  manager_employment_id: string;
  effective_from: string;
  effective_to: string | null;
  before: unknown;
};

type LineManagerPlan =
  | { readonly change: false }
  | {
      readonly change: true;
      readonly live: LiveLineRelationship | null;
      readonly managerId: string;
      readonly windowStart: string;
      readonly windowEnd: string | null;
      readonly elements: ClosureElement[];
    };

/**
 * Plan phase of a manager repoint: undefined leaves reporting untouched;
 * an unchanged manager is no change; otherwise the live line (if any) is
 * evidenced for closure and the successor reuses the assignment window.
 */
async function planLineManagerChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    employmentId: string;
    managerId: string | null | undefined;
    windowStart: string;
    windowEnd: string | null;
  },
): Promise<LineManagerPlan> {
  if (args.managerId === undefined) return { change: false };
  if (args.managerId === null) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "manager removal is not modeled — a reporting line closes only onto a successor manager; file the change without managerEmploymentId to leave reporting untouched",
    );
  }
  const live = (await exec.execute<LiveLineRelationship>(sql`
    select id, relationship_id, version_no, manager_employment_id,
           effective_from::text as effective_from,
           effective_to::text as effective_to,
           to_jsonb(reporting_relationships) as before
      from reporting_relationships
     where org_id = ${args.orgId} and employment_id = ${args.employmentId}
       and kind = 'line' and recorded_until is null
     order by version_no desc
     limit 1
  `)).rows[0] ?? null;
  if (live && live.manager_employment_id === args.managerId) {
    return { change: false };
  }
  if (live && live.version_no < 1) {
    throw new HrmChangeRequestError("REFUSED", "the reporting line carries no version — refuse the repoint");
  }
  return {
    change: true,
    live,
    managerId: args.managerId,
    windowStart: args.windowStart,
    windowEnd: args.windowEnd,
    elements:
      live === null
        ? []
        : [
            {
              table: "reporting_relationships",
              identity: live.relationship_id,
              version_no: live.version_no,
              row_id: live.id,
              before: live.before,
            },
          ],
  };
}

/**
 * Write phase: close the live line onto its successor (or open the first
 * line). Cycle and depth refusals from the 0184 guard keep their message
 * and gain the remedy; everything else propagates so nothing is masked.
 */
async function closeLineManagerChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    reporting: LineManagerPlan;
    changeId: string;
    recordedAt: DbInstant;
  },
): Promise<void> {
  if (!args.reporting.change) return;
  const { orgId, actorId, request, reporting, changeId, recordedAt } = args;
  try {
    if (reporting.live === null) {
      await exec.execute(sql`
        insert into reporting_relationships
          (org_id, employment_id, manager_employment_id, kind, relationship_id,
           version_no, effective_from, effective_to, recorded_at, created_by, updated_by)
        values (${orgId}, ${request.employment_id}, ${reporting.managerId}, 'line',
                ${randomUUID()}, 1,
                ${reporting.windowStart}::date, ${reporting.windowEnd}::date,
                ${recordedAt}, ${actorId}, ${actorId})
      `);
      return;
    }
    const successorNo = reporting.live.version_no + 1;
    const closed = (await exec.execute(sql`
      update reporting_relationships
         set recorded_until = ${recordedAt}, superseded_by = ${successorNo},
             closed_by_change_id = ${changeId}
       where org_id = ${orgId} and id = ${reporting.live.id} and recorded_until is null
      returning id
    `)).rows;
    if (closed.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the reporting line changed while the approval was applying — retry the decision",
      );
    }
    await exec.execute(sql`
      insert into reporting_relationships
        (org_id, employment_id, manager_employment_id, kind, relationship_id,
         version_no, effective_from, effective_to, recorded_at, created_by, updated_by)
      values (${orgId}, ${request.employment_id}, ${reporting.managerId}, 'line',
              ${reporting.live.relationship_id}, ${successorNo},
              ${reporting.windowStart}::date, ${reporting.windowEnd}::date,
              ${recordedAt}, ${actorId}, ${actorId})
    `);
  } catch (error) {
    if (error instanceof HrmChangeRequestError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/management cycle|65 edges/i.test(message)) {
      throw new HrmChangeRequestError(
        "REFUSED",
        `${message} — choose a manager outside the subordinate's reporting chain`,
      );
    }
    throw error;
  }
}

async function insertEmploymentChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    employmentId: string;
    assignmentId: string | null;
    revision: number;
    changeKind: string;
    priorSnapshot: Record<string, unknown>;
    closedVersions: ClosureElement[];
    reason: string;
    actorId: string;
  },
): Promise<string> {
  if (args.reason.trim().length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the application carries no reason — withdraw this request; evidence without a reason never applies",
    );
  }
  const inserted = (await exec.execute<{ id: string }>(sql`
    insert into employment_changes
      (org_id, employment_id, assignment_id, revision, change_kind,
       prior_snapshot, reason, recorded_source, recorded_by, closed_versions,
       created_by, updated_by)
    values (${args.orgId}, ${args.employmentId}, ${args.assignmentId}, ${args.revision},
            ${args.changeKind}, ${JSON.stringify(args.priorSnapshot)}::jsonb,
            ${args.reason}, 'user', ${args.actorId},
            ${JSON.stringify(args.closedVersions)}::jsonb, ${args.actorId}, ${args.actorId})
    returning id
  `)).rows[0];
  if (!inserted) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the canonical change event was not written — nothing applied; retry the decision",
    );
  }
  return inserted.id;
}

async function linkAppliedEvidence(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string; request: RequestRow; newRevision: number; changeId: string },
): Promise<void> {
  const linked = (await exec.execute(sql`
    update hrm_employment_change_requests
       set status = 'applied', applied_at = now(), applied_by = ${args.actorId},
           applied_employment_revision = ${args.newRevision},
           applied_employment_change_id = ${args.changeId},
           updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${args.request.id} and status = 'approved'
    returning id
  `)).rows;
  if (linked.length !== 1) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the request left the approved state while applying — a concurrent application won; this attempt applied nothing",
    );
  }
}

async function bumpAggregateRevision(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string; request: RequestRow; expected: number; next: number },
): Promise<void> {
  const bumped = (await exec.execute(sql`
    update worker_employments
       set revision = ${args.next}, updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${args.request.employment_id} and revision = ${args.expected}
    returning id
  `)).rows;
  if (bumped.length !== 1) {
    throw new HrmChangeRequestError(
      "STALE_REVISION",
      "the employment changed while the approval was applying — this attempt applied nothing; file a new request",
    );
  }
}

/**
 * Per-org reporting-graph serialization counter (0184): bumped on every
 * governed application so concurrent writers across employments sharing one
 * reporting graph serialize on the row lock instead of walking stale
 * snapshots. Monotonic and product-meaningless — never read as data.
 */
async function bumpGraphRevision(exec: SqlExecutor, orgId: string): Promise<void> {
  await exec.execute(sql`
    insert into hrm_graph_revisions (org_id, rev) values (${orgId}, 1)
    on conflict (org_id) do update set rev = hrm_graph_revisions.rev + 1, updated_at = now()
  `);
}



