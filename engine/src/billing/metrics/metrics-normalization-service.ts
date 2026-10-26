import { ScopeNotFoundError } from "../../organization/subsidiary-scope.ts";
import {
  routeNativeApproval,
  readNativeApprovalDecision,
  lockApprovalSubject,
  cancelNativeApprovals,
} from "../../platform/approval-routing.ts";
import { lockActorCommandAuthority } from "../../organization/actor-command-authority.ts";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../../organization/org-feature-lock.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { UsageBillingError } from "../usage/errors.ts";
import {
  canonicalNormalizationJson,
  SAAS_METRICS_DENOMINATION_VERSION,
} from "./metrics-normalization.ts";
import {
  computeLegacyV0Month,
  computeNormalizedMetricsMonth,
  readStoredMetricsMonth,
  writeNormalizedMetricsMonth,
  type LegacyV0Month,
  type NormalizedMetricsMonth,
  type StoredMetricsMonth,
} from "./metrics-ledger.ts";

/**
 * Audited tenant-governed normalization service for SaaS metrics.
 *
 * Normal recompute stays frozen for closed months. The only path that may
 * replace legacy rows — including rows in a closed month — is an approved
 * correction request executed here: exactly one org and month per request,
 * a frozen tenant Flow policy, a fenced lease token
 * that serializes workers, a byte-for-byte proof of the legacy row set
 * before any write, the same v1 computation and writers the ordinary
 * recompute uses, per-row before/after evidence in the canonical audit_log,
 * and a fenced terminal finalization. There is no normalization_attempts
 * table: the request row owns current fenced liveness and the append-only
 * audit_log owns typed attempt transitions plus per-row correction history.
 * Raw lease tokens never enter audit; only their digests do.
 */

const FEATURES_REMEDY = "Enable SaaS metrics in Company Settings → Features.";
const SETUP_LIST_REMEDY =
  "Open Company Setup → SaaS Metrics to review the request and its recorded result.";
const DEFAULT_LEASE_MINUTES = 10;

export type NormalizationRequestStatus =
  "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface NormalizationRequestRecord {
  id: string;
  orgId: string;
  month: string;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  idempotencyKey: string;
  requestHash: string;
  status: NormalizationRequestStatus;
  progress: Record<string, unknown>;
  result: NormalizationExecutionResult | null;
  failure: string | null;
  remedy: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizationExecutionResult {
  requestId: string;
  month: string;
  attempt: number;
  reportingCurrency: string;
  denominationVersion: string;
  monthHash: string;
  subscriptionRows: number;
  subsidiaryRows: number;
  replacedMonthly: number;
  replacedFacts: number;
  replacedCohorts: number;
  sourceV0Hashes: string[];
}

function refusal(
  code: string,
  message: string,
  remedy: string,
  options?: { field?: string | null; status?: 422 | 409 },
): UsageBillingError {
  return new UsageBillingError(code, message, remedy, options);
}

function requireUuid(value: string, field: string): string {
  const trimmed = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    throw refusal(
      `saas_normalization_${field}_invalid`,
      `Normalization ${field.replaceAll("_", " ")} "${value}" is not a UUID.`,
      `Supply the ${field.replaceAll("_", " ")} as a UUID from Company Setup → SaaS Metrics.`,
      { field },
    );
  }
  return trimmed;
}

function requireMonthStart(month: string): string {
  const trimmed = month.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(trimmed)) {
    throw refusal(
      "saas_normalization_month_invalid",
      `Normalization month "${month}" must be the first day of a calendar month.`,
      "Supply the month as YYYY-MM-01 from Company Setup → SaaS Metrics.",
      { field: "month" },
    );
  }
  return trimmed;
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 8 || trimmed.length > 1000) {
    throw refusal(
      "saas_normalization_reason_invalid",
      "A normalization request needs a reason between 8 and 1000 characters.",
      "Describe why the month needs correction in Company Setup → SaaS Metrics, then submit again.",
      { field: "reason" },
    );
  }
  return trimmed;
}

/** Canonical body hash: same key with a byte-identical body replays, any difference conflicts. */
function requestBodyHash(args: {
  orgId: string;
  month: string;
  reason: string;
  requestedBy: string;
}): string {
  return createHash("sha256")
    .update(canonicalNormalizationJson({ v: 1, ...args }), "utf8")
    .digest("hex");
}

/**
 * Digest stored in audit for lease transitions. The database guard computes
 * the same `sha256:` hex over the token text; the raw token never leaves
 * the worker that holds it.
 */
export function normalizationLeaseDigest(leaseToken: string): string {
  return `sha256:${createHash("sha256").update(leaseToken, "utf8").digest("hex")}`;
}

/**
 * Deterministic fence identity for one org and month correction, on the same
 * key family as the usage rate-run precedent. D-specific so a normalization
 * worker never contends with an unrelated advisory lock.
 */
export function normalizationMonthLockKey(orgId: string, month: string): string {
  return `openbooks:saas-normalization:${orgId}:${month}`;
}

type RequestRow = {
  id: string;
  org_id: string;
  month: string;
  reason: string;
  requested_by: string;
  approved_by: string | null;
  approved_at: string | null;
  idempotency_key: string;
  request_hash: string;
  status: NormalizationRequestStatus;
  progress: Record<string, unknown>;
  result: NormalizationExecutionResult | null;
  failure: string | null;
  remedy: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

const REQUEST_COLUMNS = sql`
  id::text as id, org_id::text as org_id, month::text as month, reason,
  requested_by::text as requested_by, approved_by::text as approved_by,
  approved_at::text as approved_at, idempotency_key::text as idempotency_key,
  request_hash as request_hash, status, progress,
  result as result, failure, remedy,
  lease_expires_at::text as lease_expires_at, attempt_count,
  last_heartbeat_at::text as last_heartbeat_at,
  created_at::text as created_at, updated_at::text as updated_at
`;

function toRecord(row: RequestRow): NormalizationRequestRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    month: row.month.slice(0, 10),
    reason: row.reason,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    progress: row.progress ?? {},
    result: row.result,
    failure: row.failure,
    remedy: row.remedy,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readRequest(
  executor: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<RequestRow | null> {
  const rows = await executor.execute<RequestRow>(
    sql`
    select ${REQUEST_COLUMNS}
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and id = ${requestId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

function missingRequest(requestId: string): UsageBillingError {
  return refusal(
    "saas_normalization_request_missing",
    `Normalization request ${requestId} does not exist in this organization.`,
    "Choose an existing request in Company Setup → SaaS Metrics, or submit a new request for the month.",
    { field: "requestId", status: 409 },
  );
}

function liveRequestRemedy(existing: NormalizationRequestRecord): string {
  return (
    `Request ${existing.id} for ${existing.month} is already ${existing.status}. ` +
    "Open the request in Company Setup → SaaS Metrics. Complete its assigned Flow gates or, while pending, have its requester cancel it."
  );
}

/**
 * Request-state remedies describe supported native actions without exposing
 * the server's execution fence or granting another approval path.
 */
function claimStateRemedy(existing: NormalizationRequestRecord): string {
  switch (existing.status) {
    case "running":
      return liveRequestRemedy(existing);
    case "succeeded":
      return (
        `Request ${existing.id} for ${existing.month} already succeeded. ` +
        "Review the stored month and its recorded result in Company Setup → SaaS Metrics; file a new request for further work."
      );
    case "failed":
      return (
        `Request ${existing.id} for ${existing.month} already failed. ` +
        "Review the recorded failure in Company Setup → SaaS Metrics, correct its cause and submit a new correction through the tenant’s Flows."
      );
    case "cancelled":
      return (
        `Request ${existing.id} for ${existing.month} was cancelled and is immutable. ` +
        "File a new request in Company Setup → SaaS Metrics for further work."
      );
    default:
      return liveRequestRemedy(existing);
  }
}

/**
 * File exactly one org and month per request. Same org, key, and
 * byte-identical body returns the existing request; the same key with a
 * different body refuses by name; a second live request for the month
 * refuses with the live request named. The insert trigger records the
 * typed requested audit event with the requester as actor.
 */
export async function createNormalizationRequest(args: {
  orgId: string;
  month: string;
  reason: string;
  requestedBy: string;
  idempotencyKey: string;
}): Promise<{ request: NormalizationRequestRecord; created: boolean }> {
  const orgId = requireUuid(args.orgId, "org_id");
  const month = requireMonthStart(args.month);
  const reason = requireReason(args.reason);
  const requestedBy = requireUuid(args.requestedBy, "requested_by");
  const idempotencyKey = requireUuid(args.idempotencyKey, "idempotency_key");
  const bodyHash = requestBodyHash({ orgId, month, reason, requestedBy });
  return withOrgTransaction(orgId, async () => {
    await lockNormalizationOperator(orgId, requestedBy);
    const attemptInsert = async (): Promise<{
      request: NormalizationRequestRecord;
      created: boolean;
    } | null> => {
      try {
        const inserted = await db.execute<RequestRow>(
          sql`
          insert into saas_metrics_normalization_requests
            (org_id, month, reason, requested_by, idempotency_key, request_hash, created_by, updated_by)
          values (${orgId}, ${month}::date, ${reason}, ${requestedBy}, ${idempotencyKey}, ${bodyHash},
                  ${requestedBy}, ${requestedBy})
          returning ${REQUEST_COLUMNS}
        `,
          "objects",
        );
        if (inserted.length !== 1 || !inserted[0]) {
          throw refusal(
            "saas_normalization_request_write_missing",
            `Normalization request for ${month} was not stored.`,
            "Confirm the organization still exists in Company Setup → SaaS Metrics, then submit again.",
          );
        }
        const id = inserted[0]!.id;
        const routing = await routeNativeApproval({
          orgId,
          actorId: requestedBy,
          subjectKind: "metrics_normalization",
          subjectId: id,
        });
        if (routing.policy.kind === "ungated") {
          const released = await approveAndExecuteNormalizationRequest({
            orgId,
            requestId: id,
            approverId: requestedBy,
          });
          return { request: released.request, created: true };
        }
        return { request: toRecord(inserted[0]!), created: true };
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== "23505") throw error;
        return null;
      }
    };
    const replayOrRefuse = async (): Promise<{
      request: NormalizationRequestRecord;
      created: boolean;
    }> => {
      const byKey = await readRequestByKey(db, orgId, idempotencyKey);
      if (byKey) {
        if (byKey.request_hash === bodyHash) return { request: toRecord(byKey), created: false };
        throw refusal(
          "saas_normalization_idempotency_conflict",
          `Idempotency key ${idempotencyKey} already belongs to request ${byKey.id} with a different body.`,
          "Reuse the original request body with this idempotency key, or generate a new idempotency key in Company Setup → SaaS Metrics.",
          { field: "idempotency_key", status: 409 },
        );
      }
      const live = await readLiveRequest(db, orgId, month);
      if (live) {
        throw refusal(
          "saas_normalization_request_live",
          `A ${live.status} normalization request ${live.id} already covers ${month}.`,
          liveRequestRemedy(toRecord(live)),
          { field: "month", status: 409 },
        );
      }
      throw refusal(
        "saas_normalization_request_write_missing",
        `Normalization request for ${month} was not stored.`,
        "Confirm the organization still exists in Company Setup → SaaS Metrics, then submit again.",
      );
    };
    const byKey = await readRequestByKey(db, orgId, idempotencyKey);
    if (byKey) {
      if (byKey.request_hash === bodyHash) return { request: toRecord(byKey), created: false };
      throw refusal(
        "saas_normalization_idempotency_conflict",
        `Idempotency key ${idempotencyKey} already belongs to request ${byKey.id} with a different body.`,
        "Reuse the original request body with this idempotency key, or generate a new idempotency key in Company Setup → SaaS Metrics.",
        { field: "idempotency_key", status: 409 },
      );
    }
    const live = await readLiveRequest(db, orgId, month);
    if (live) {
      throw refusal(
        "saas_normalization_request_live",
        `A ${live.status} normalization request ${live.id} already covers ${month}.`,
        liveRequestRemedy(toRecord(live)),
        { field: "month", status: 409 },
      );
    }
    return (await attemptInsert()) ?? replayOrRefuse();
  });
}

async function readRequestByKey(
  executor: SqlExecutor,
  orgId: string,
  idempotencyKey: string,
): Promise<RequestRow | null> {
  const rows = await executor.execute<RequestRow>(
    sql`
    select ${REQUEST_COLUMNS}
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and idempotency_key = ${idempotencyKey}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

async function readLiveRequest(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<RequestRow | null> {
  const rows = await executor.execute<RequestRow>(
    sql`
    select ${REQUEST_COLUMNS}
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and month = ${month}::date and status in ('pending', 'running')
  `,
    "objects",
  );
  return rows[0] ?? null;
}

async function diagnoseFenceMiss(
  executor: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<never> {
  const existing = await readRequest(executor, orgId, requestId);
  if (!existing) throw missingRequest(requestId);
  const record = toRecord(existing);
  if (existing.status !== "running") {
    throw refusal(
      "saas_normalization_lease_state",
      `Request ${requestId} is ${existing.status} and holds no live lease.`,
      record.status === "failed"
        ? "Review the recorded failure in Company Setup → SaaS Metrics, correct its cause and submit a new correction through the tenant’s Flows."
        : SETUP_LIST_REMEDY,
      { status: 409 },
    );
  }
  const expiry =
    (
      await executor.execute<{ expired: boolean }>(
        sql`
    select lease_expires_at <= now() as expired
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and id = ${requestId}
  `,
        "objects",
      )
    )[0]?.expired ?? true;
  throw refusal(
    "saas_normalization_lease_mismatch",
    `The presented lease token does not match the live lease for request ${requestId}.`,
    expiry
      ? "The correction execution expired. Reload its native request and retry the original Flow decision after reviewing its recorded state."
      : "A correction is already executing. Wait for its result and reload the native request before retrying.",
    { field: "leaseToken", status: 409 },
  );
}

/** Cancel a pending request (requester) or a running/failed one (approver, live lease for running). */
export async function cancelNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  actorId: string;
}): Promise<NormalizationRequestRecord> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const actorId = requireUuid(args.actorId, "actor_id");
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "metrics_normalization", requestId);
    await lockNormalizationOperator(orgId, actorId);
    const existing = await readRequest(db, orgId, requestId);
    if (!existing) throw missingRequest(requestId);
    if (existing.status === "pending") {
      if (actorId !== existing.requested_by) {
        throw refusal(
          "saas_normalization_cancel_forbidden",
          `Only the requester can cancel pending request ${requestId}.`,
          "Have the requester cancel it in Company Setup → SaaS Metrics, or record an approval to move it forward.",
          { status: 409 },
        );
      }
      await cancelNativeApprovals({
        orgId,
        actorId,
        subjectKind: "metrics_normalization",
        subjectId: requestId,
      });
      const updated = await db.execute<RequestRow>(
        sql`
        update saas_metrics_normalization_requests
           set status = 'cancelled', updated_by = ${actorId}
         where org_id = ${orgId} and id = ${requestId} and status = 'pending'
        returning ${REQUEST_COLUMNS}
      `,
        "objects",
      );
      if (updated.length !== 1 || !updated[0]) throw missingRequest(requestId);
      return toRecord(updated[0]!);
    }
    throw refusal(
      "saas_normalization_cancel_state",
      `Request ${requestId} is ${existing.status} and cannot be cancelled; only a pending correction can be withdrawn.`,
      "File a new request in Company Setup → SaaS Metrics for further work.",
      { status: 409 },
    );
  });
}

interface LiveClaim {
  month: string;
  attempt: number;
  approvedBy: string;
  reason: string;
  idempotencyKey: string;
}

/**
 * Fenced execution authorization: org plus request id plus expected
 * running status plus presented live token plus unexpired lease, extended
 * for the attempt. Zero matching rows refuse by name, never success. A
 * request that already succeeded replays its recorded result.
 */
async function assertLiveClaim(
  executor: SqlExecutor,
  orgId: string,
  requestId: string,
  leaseToken: string,
  ttlMinutes: number,
): Promise<
  { kind: "replay"; result: NormalizationExecutionResult } | { kind: "live"; claim: LiveClaim }
> {
  const existing = await readRequest(executor, orgId, requestId);
  if (!existing) throw missingRequest(requestId);
  if (existing.status === "succeeded" && existing.result) {
    return { kind: "replay", result: existing.result };
  }
  if (existing.status !== "running") {
    throw refusal(
      "saas_normalization_execute_state",
      `Request ${requestId} is ${existing.status} and cannot execute.`,
      existing.status === "pending"
        ? "Complete the request’s tenant Flow gates in Approvals; the final decision executes the correction automatically."
        : existing.status === "failed"
          ? "Review the recorded failure in Company Setup → SaaS Metrics and submit the corrected request through its tenant Flows."
          : SETUP_LIST_REMEDY,
      { status: 409 },
    );
  }
  const claimed = await executor.execute<{
    month: string;
    attempt_count: number;
    approved_by: string;
    reason: string;
    idempotency_key: string;
  }>(
    sql`
    update saas_metrics_normalization_requests
       set lease_expires_at = greatest(lease_expires_at, now() + make_interval(mins => ${ttlMinutes})),
           progress = progress || '{"phase":"executing"}'::jsonb,
           updated_by = approved_by
     where org_id = ${orgId} and id = ${requestId} and status = 'running'
       and lease_token = ${leaseToken} and lease_expires_at > now()
    returning month::text as month, attempt_count, approved_by::text as approved_by,
              reason, idempotency_key::text as idempotency_key
  `,
    "objects",
  );
  if (claimed.length !== 1 || !claimed[0]) {
    await diagnoseFenceMiss(executor, orgId, requestId);
  }
  const row = claimed[0]!;
  if (!row.approved_by) {
    throw refusal(
      "saas_normalization_execute_unapproved",
      `Request ${requestId} holds a running lease with no recorded approver.`,
      SETUP_LIST_REMEDY,
      { status: 409 },
    );
  }
  return {
    kind: "live",
    claim: {
      month: row.month.slice(0, 10),
      attempt: row.attempt_count,
      approvedBy: row.approved_by,
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
    },
  };
}

async function markProgress(
  executor: SqlExecutor,
  orgId: string,
  requestId: string,
  leaseToken: string,
  progress: Record<string, unknown>,
): Promise<void> {
  const updated = await executor.execute<{ id: string }>(
    sql`
    update saas_metrics_normalization_requests
       set progress = progress || ${JSON.stringify(progress)}::jsonb,
           updated_by = approved_by
     where org_id = ${orgId} and id = ${requestId} and status = 'running'
       and lease_token = ${leaseToken} and lease_expires_at > now()
    returning id
  `,
    "objects",
  );
  if (updated.length !== 1) {
    await diagnoseFenceMiss(executor, orgId, requestId);
  }
}

/** Classify the stored month before reading legacy dependencies for its proof. */
function assertLegacyMonth(before: StoredMetricsMonth, month: string): void {
  const all = [...before.monthly, ...before.facts, ...before.cohorts];
  if (all.length === 0) {
    throw refusal(
      "saas_normalization_nothing_to_correct",
      `Month ${month} holds no stored metrics rows, so there is nothing to normalize.`,
      "Recompute the month through the ordinary SaaS metrics recompute, which writes normalized rows directly.",
      { field: "month", status: 409 },
    );
  }
  const isLegacy = (row: {
    reportingCurrency: string | null;
    denominationVersion: string | null;
  }): boolean => row.reportingCurrency === null && row.denominationVersion === null;
  const legacy = all.filter(isLegacy);
  if (legacy.length !== all.length) {
    const complete = all.filter(
      (row) => row.reportingCurrency !== null && row.denominationVersion !== null,
    );
    if (complete.length === all.length) {
      throw refusal(
        "saas_normalization_already_normalized",
        `Month ${month} already carries normalized denomination evidence; no correction is needed.`,
        `Review the stored month in Company Setup → SaaS Metrics; normalized rows may come from the ordinary recompute as well as an approved correction.`,
        { field: "month", status: 409 },
      );
    }
    throw refusal(
      "saas_normalization_partial_denominations",
      `Month ${month} mixes legacy and normalized rows, which one correction request cannot reconcile.`,
      "Have an administrator investigate the month's recorded evidence in Company Setup → SaaS Metrics and escalate with the request id; derived metrics rows are never edited by hand.",
      { field: "month", status: 409 },
    );
  }
}

/**
 * Natural keys, row counts, every stored value and one common historical
 * writer hash must agree with the read-only reproduction. Source changes,
 * altered values and missing keys all refuse before any correction write.
 */
function proveLegacyMonth(
  before: StoredMetricsMonth,
  reproduced: LegacyV0Month,
  month: string,
): string[] {
  const all = [...before.monthly, ...before.facts, ...before.cohorts];
  // Natural-key grain first: the proved sets must match the reproduced
  // sets exactly, in both directions, before any value is compared.
  const storedMonthlyKeys = new Set(before.monthly.map((row) => row.subscriptionId));
  const v0MonthlyKeys = new Set(reproduced.monthly.map((row) => row.subscriptionId));
  const storedFactsKeys = new Set(before.facts.map((row) => row.subsidiaryId));
  const v0FactsKeys = new Set(reproduced.facts.map((row) => row.subsidiaryId));
  const storedCohortKeys = new Set(
    before.cohorts.map((row) => `${row.subsidiaryId}:${row.cohortMonth}`),
  );
  const v0CohortKeys = new Set(
    reproduced.cohorts.map((row) => `${row.subsidiaryId}:${row.cohortMonth}`),
  );
  const keyDrift = [
    ...[...storedMonthlyKeys]
      .filter((key) => !v0MonthlyKeys.has(key))
      .map((key) => `saas_metrics_monthly:${key}`),
    ...[...v0MonthlyKeys]
      .filter((key) => !storedMonthlyKeys.has(key))
      .map((key) => `saas_metrics_monthly:${key}`),
    ...[...storedFactsKeys]
      .filter((key) => !v0FactsKeys.has(key))
      .map((key) => `saas_metrics_facts_monthly:${key}`),
    ...[...v0FactsKeys]
      .filter((key) => !storedFactsKeys.has(key))
      .map((key) => `saas_metrics_facts_monthly:${key}`),
    ...[...storedCohortKeys]
      .filter((key) => !v0CohortKeys.has(key))
      .map((key) => `saas_metrics_cohort_monthly:${key}`),
    ...[...v0CohortKeys]
      .filter((key) => !storedCohortKeys.has(key))
      .map((key) => `saas_metrics_cohort_monthly:${key}`),
  ];
  if (keyDrift.length > 0) {
    throw refusal(
      "saas_normalization_v0_key_drift",
      `Month ${month} no longer reproduces its recorded natural keys (${keyDrift.slice(0, 3).join(", ")}${keyDrift.length > 3 ? ", …" : ""}).`,
      "Normalize earlier months first in Company Setup → SaaS Metrics so openings settle, then file a new request; if every source is unchanged, have an administrator investigate with the request id.",
      { field: "month", status: 409 },
    );
  }
  // One common stored hash must match an exact historical writer payload:
  // either the initial computation or the repeat with its cohort opening.
  const storedHashes = [...new Set(all.map((row) => row.inputsHash))];
  if (
    storedHashes.length !== 1 ||
    (storedHashes[0] !== reproduced.legacyHash && storedHashes[0] !== reproduced.initialLegacyHash)
  ) {
    const valuesMatch = compareV0Values(before, reproduced).length === 0;
    if (valuesMatch) {
      throw refusal(
        "saas_normalization_hash_tamper",
        `Month ${month} reproduces its recorded values but not its recorded inputs hash.`,
        "Have an administrator investigate the month's recorded evidence in Company Setup → SaaS Metrics and escalate with the request id; derived metrics rows are never edited by hand.",
        { field: "month", status: 409 },
      );
    }
    throw refusal(
      "saas_normalization_source_drift",
      `Month ${month} no longer reproduces its recorded legacy evidence from the current sources.`,
      "Normalize earlier months first in Company Setup → SaaS Metrics so openings settle, correct any changed subscription, FX rate, journal, or definition input, then file a new request.",
      { field: "month", status: 409 },
    );
  }
  // The hashes agree, so every stored value must agree too; otherwise the
  // stored rows were altered after recording.
  const valueDrift = compareV0Values(before, reproduced);
  if (valueDrift.length > 0) {
    throw refusal(
      "saas_normalization_stored_tamper",
      `Month ${month} carries its recorded inputs hash but not its recorded values (${valueDrift[0]}).`,
      "Have an administrator investigate the month's recorded evidence in Company Setup → SaaS Metrics and escalate with the request id; derived metrics rows are never edited by hand.",
      { field: "month", status: 409 },
    );
  }
  return storedHashes as string[];
}

const V0_MONTHLY_FIELDS = [
  "subsidiaryId",
  "customerId",
  "month",
  "cohortMonth",
  "mrrStart",
  "mrrEnd",
  "newMrr",
  "expansionMrr",
  "contractionMrr",
  "churnedMrr",
  "reactivationMrr",
  "movement",
  "recognizedRevenue",
  "deferredDelta",
] as const;

const V0_FACTS_FIELDS = [
  "subsidiaryId",
  "month",
  "mrrStart",
  "mrrEnd",
  "newMrr",
  "expansionMrr",
  "contractionMrr",
  "churnedMrr",
  "reactivationMrr",
  "recognizedRevenue",
  "deferredDelta",
  "mrrAtRisk",
  "customersStart",
  "customersEnd",
  "customersNew",
  "customersChurned",
  "customersReactivated",
  "glRevenue",
  "glCogs",
  "bookings",
  "billings",
  "deferredBalance",
  "basis",
] as const;

const V0_COHORT_FIELDS = [
  "subsidiaryId",
  "cohortMonth",
  "month",
  "monthsSinceStart",
  "startMrr",
  "mrr",
  "startCustomers",
  "customers",
] as const;

/** Field-level comparison of stored legacy rows against the v0 reproduction; empty means exact. */
function compareV0Values(before: StoredMetricsMonth, reproduced: LegacyV0Month): string[] {
  const drift: string[] = [];
  const v0MonthlyByKey = new Map(reproduced.monthly.map((row) => [row.subscriptionId, row]));
  for (const stored of before.monthly) {
    const expected = v0MonthlyByKey.get(stored.subscriptionId);
    if (!expected) continue;
    for (const field of V0_MONTHLY_FIELDS) {
      if (String(stored[field]) !== String(expected[field])) {
        drift.push(`saas_metrics_monthly:${stored.subscriptionId}.${field}`);
      }
    }
  }
  const v0FactsByKey = new Map(reproduced.facts.map((row) => [row.subsidiaryId, row]));
  for (const stored of before.facts) {
    const expected = v0FactsByKey.get(stored.subsidiaryId);
    if (!expected) continue;
    for (const field of V0_FACTS_FIELDS) {
      if (String(stored[field]) !== String(expected[field])) {
        drift.push(`saas_metrics_facts_monthly:${stored.subsidiaryId}.${field}`);
      }
    }
  }
  const v0CohortsByKey = new Map(
    reproduced.cohorts.map((row) => [`${row.subsidiaryId}:${row.cohortMonth}`, row]),
  );
  for (const stored of before.cohorts) {
    const expected = v0CohortsByKey.get(`${stored.subsidiaryId}:${stored.cohortMonth}`);
    if (!expected) continue;
    for (const field of V0_COHORT_FIELDS) {
      if (String(stored[field]) !== String(expected[field])) {
        drift.push(
          `saas_metrics_cohort_monthly:${stored.subsidiaryId}:${stored.cohortMonth}.${field}`,
        );
      }
    }
  }
  return drift;
}

type CorrectionAuditSeed = {
  table: string;
  rowId: string;
  naturalKey: Record<string, unknown>;
  change: "corrected";
  before: unknown;
  after: unknown;
  sourceV0Hash: string | null;
};

/**
 * The v1 correction preserves the proved grain: every computed natural key
 * must already exist in the proved before-image and vice versa, with equal
 * row counts per set. Normalization changes amounts and evidence, never
 * subscription, subsidiary, or cohort identity.
 */
function assertSameGrain(
  before: StoredMetricsMonth,
  normalized: NormalizedMetricsMonth,
  month: string,
): void {
  const missing: string[] = [];
  const beforeMonthly = new Set(before.monthly.map((row) => row.subscriptionId));
  const v1Monthly = new Set(normalized.computed.rows.map((row) => row.subscriptionId));
  const beforeFacts = new Set(before.facts.map((row) => row.subsidiaryId));
  const v1Facts = new Set(normalized.facts.map((row) => row.subsidiaryId));
  const beforeCohorts = new Set(
    before.cohorts.map((row) => `${row.subsidiaryId}:${row.cohortMonth}`),
  );
  const v1Cohorts = new Set(
    normalized.cohorts.map((row) => `${row.subsidiaryId}:${row.cohortMonth}`),
  );
  for (const key of v1Monthly)
    if (!beforeMonthly.has(key)) missing.push(`saas_metrics_monthly:${key}`);
  for (const key of beforeMonthly)
    if (!v1Monthly.has(key)) missing.push(`saas_metrics_monthly:${key}`);
  for (const key of v1Facts)
    if (!beforeFacts.has(key)) missing.push(`saas_metrics_facts_monthly:${key}`);
  for (const key of beforeFacts)
    if (!v1Facts.has(key)) missing.push(`saas_metrics_facts_monthly:${key}`);
  for (const key of v1Cohorts)
    if (!beforeCohorts.has(key)) missing.push(`saas_metrics_cohort_monthly:${key}`);
  for (const key of beforeCohorts)
    if (!v1Cohorts.has(key)) missing.push(`saas_metrics_cohort_monthly:${key}`);
  if (
    missing.length > 0 ||
    normalized.computed.rows.length !== before.monthly.length ||
    normalized.facts.length !== before.facts.length ||
    normalized.cohorts.length !== before.cohorts.length
  ) {
    throw refusal(
      "saas_normalization_grain_changed",
      `Month ${month} changed membership during its correction${missing.length > 0 ? ` (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})` : ""}.`,
      "Retry the request in Company Setup → SaaS Metrics; every metric write was rolled back and the attempt re-proves the month before any write.",
      { field: "month", status: 409 },
    );
  }
}

/** Per-row before/after correction evidence in the canonical audit_log; raw tokens never appear. */
async function writeCorrectionAudit(
  executor: SqlExecutor,
  args: {
    orgId: string;
    requestId: string;
    idempotencyKey: string;
    month: string;
    attempt: number;
    actor: string;
    reason: string;
    monthHash: string;
    seeds: CorrectionAuditSeed[];
  },
): Promise<void> {
  for (const seed of args.seeds) {
    const after = seed.after as { normalizationEvidence?: unknown } | null;
    const inserted = await executor.execute<{ id: string }>(
      sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${args.orgId}, ${seed.table}, ${seed.rowId}, 'saas_normalization_corrected',
        ${JSON.stringify({
          event: "saas_normalization_corrected",
          requestId: args.requestId,
          month: args.month,
          attempt: args.attempt,
          actor: args.actor,
          reason: args.reason,
          table: seed.table,
          naturalKey: seed.naturalKey,
          change: seed.change,
          before: seed.before,
          after: seed.after,
          sourceV0Hash: seed.sourceV0Hash,
          v1Hash: args.monthHash,
          v1Evidence: after?.normalizationEvidence ?? null,
        })}::jsonb, ${args.actor}, ${args.idempotencyKey})
      returning id
    `,
      "objects",
    );
    if (inserted.length !== 1) {
      throw refusal(
        "saas_normalization_audit_write_missing",
        `Correction evidence for ${seed.table} row ${seed.rowId} was not recorded.`,
        "Retry the request in Company Setup → SaaS Metrics; every metric write was rolled back with the missing evidence.",
        { status: 409 },
      );
    }
  }
}

function toFailure(
  error: unknown,
  month: string,
): { failure: string; remedy: string; error: UsageBillingError } {
  if (error instanceof UsageBillingError) {
    return { failure: `[${error.code}] ${error.message}`, remedy: error.remedy, error };
  }
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = refusal(
    "saas_normalization_execution_failed",
    `Normalization execution for ${month} stopped before any metric change was kept: ${detail}`,
    "Review the failure detail, correct the cause, then retry the request in Company Setup → SaaS Metrics; the month's stored rows are unchanged.",
  );
  return {
    failure: `[saas_normalization_execution_failed] ${wrapped.message}`,
    remedy: wrapped.remedy,
    error: wrapped,
  };
}

/**
 * Record a guarded failed outcome under the live lease in a fresh
 * transaction (the attempt transaction already rolled back). If the fence
 * misses — the execution fence expired or its attempt is no longer current — the
 * original refusal propagates so the new lease owner stays authoritative.
 */
async function recordExecutionFailure(args: {
  orgId: string;
  requestId: string;
  leaseToken: string;
  failure: string;
  remedy: string;
  original: UsageBillingError;
}): Promise<never> {
  try {
    await withOrgTransaction(args.orgId, async () => {
      const updated = await db.execute<{ id: string }>(
        sql`
        update saas_metrics_normalization_requests
           set status = 'failed', failure = ${args.failure}, remedy = ${args.remedy},
               progress = progress || '{"phase":"failed"}'::jsonb,
               updated_by = approved_by
         where org_id = ${args.orgId} and id = ${args.requestId} and status = 'running'
           and lease_token = ${args.leaseToken} and lease_expires_at > now()
        returning id
      `,
        "objects",
      );
      if (updated.length !== 1) {
        await diagnoseFenceMiss(db, args.orgId, args.requestId);
      }
    });
  } catch (recordError) {
    if (
      recordError instanceof UsageBillingError &&
      recordError.code.startsWith("saas_normalization_lease")
    ) {
      throw args.original;
    }
    throw recordError;
  }
  throw args.original;
}

/** Read one request and its recorded outcome. The live lease token is never returned. */
export async function getNormalizationRequest(args: {
  orgId: string;
  requestId: string;
}): Promise<NormalizationRequestRecord> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  return withOrgTransaction(orgId, async () => {
    const existing = await readRequest(db, orgId, requestId);
    if (!existing) throw missingRequest(requestId);
    return toRecord(existing);
  });
}

/**
 * Execute one fenced correction attempt in a single transaction. The month
 * arrives from the outer control lookup and is used only as the advisory
 * lock key: inside the transaction the org feature-gate fence comes first
 * with its recheck, then the deterministic org/month correction lock, and
 * only then does the attempt reread and fence the request, verify its
 * immutable month, prove the legacy month byte-for-byte, compute through
 * the shared v1 pipeline, replace that month's three row sets atomically,
 * record per-row before/after evidence, and finalize succeeded under the
 * live token. No request or metric read precedes those locks. Any drift
 * rolls every metric write back; the caller records the guarded failed
 * outcome outside this transaction.
 */
async function runCorrectionAttempt(
  orgId: string,
  requestId: string,
  leaseToken: string,
  month: string,
  ttlMinutes: number,
): Promise<NormalizationExecutionResult> {
  return withOrgTransaction(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "saasMetrics"))) {
      throw refusal(
        "feature_off",
        "SaaS metrics are disabled for this organization.",
        FEATURES_REMEDY,
      );
    }
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${normalizationMonthLockKey(orgId, month)}, 0))`,
    );
    const assertion = await assertLiveClaim(db, orgId, requestId, leaseToken, ttlMinutes);
    if (assertion.kind === "replay") return assertion.result;
    const { claim } = assertion;
    if (claim.month !== month) {
      throw refusal(
        "saas_normalization_month_mismatch",
        `Request ${requestId} covers ${claim.month}, not the executed month ${month}.`,
        SETUP_LIST_REMEDY,
        { field: "month", status: 409 },
      );
    }
    const before = await readStoredMetricsMonth(db, orgId, claim.month);
    assertLegacyMonth(before, claim.month);
    const reproduced = await computeLegacyV0Month(db, orgId, claim.month);
    const sourceV0Hashes = proveLegacyMonth(before, reproduced, claim.month);
    await markProgress(db, orgId, requestId, leaseToken, {
      phase: "proof-complete",
      storedMonthly: before.monthly.length,
      storedFacts: before.facts.length,
      storedCohorts: before.cohorts.length,
    });
    const normalized = await computeNormalizedMetricsMonth(db, orgId, claim.month);
    await markProgress(db, orgId, requestId, leaseToken, {
      phase: "compute-complete",
      monthHash: normalized.monthHash,
      reportingCurrency: normalized.reportingCurrency,
    });
    // Denomination may change amounts and evidence, never identity: the v1
    // correction must preserve the proved natural-key sets and grain
    // exactly. Added or removed keys mean the sources moved under the
    // attempt, so the batch refuses before any delete or write.
    assertSameGrain(before, normalized, claim.month);
    // Atomic replacement inside the transaction: the proven rows leave
    // first with exact-count deletes, then the shared writers store v1.
    // A closed month is corrected here only under this approved request;
    // the accounting period itself is never reopened and posted history is
    // never reversed or rewritten.
    const deletedMonthly = await db.execute<{ id: string }>(
      sql`
      delete from saas_metrics_monthly
       where org_id = ${orgId} and month = ${claim.month}::date returning id
    `,
      "objects",
    );
    const deletedFacts = await db.execute<{ id: string }>(
      sql`
      delete from saas_metrics_facts_monthly
       where org_id = ${orgId} and month = ${claim.month}::date returning id
    `,
      "objects",
    );
    const deletedCohorts = await db.execute<{ id: string }>(
      sql`
      delete from saas_metrics_cohort_monthly
       where org_id = ${orgId} and month = ${claim.month}::date returning id
    `,
      "objects",
    );
    if (
      deletedMonthly.length !== before.monthly.length ||
      deletedFacts.length !== before.facts.length ||
      deletedCohorts.length !== before.cohorts.length
    ) {
      throw refusal(
        "saas_normalization_row_count_drift",
        `Month ${claim.month} changed under its correction; the proven row counts no longer match.`,
        "Retry the request in Company Setup → SaaS Metrics; every metric write was rolled back and the attempt re-proves the month before any write.",
        { status: 409 },
      );
    }
    await writeNormalizedMetricsMonth(db, orgId, normalized);
    const after = await readStoredMetricsMonth(db, orgId, claim.month);
    if (
      after.monthly.length !== normalized.computed.rows.length ||
      after.facts.length !== normalized.facts.length ||
      after.cohorts.length !== normalized.cohorts.length ||
      ![...after.monthly, ...after.facts, ...after.cohorts].every(
        (row) =>
          row.inputsHash === normalized.monthHash &&
          row.reportingCurrency === normalized.reportingCurrency &&
          row.denominationVersion === SAAS_METRICS_DENOMINATION_VERSION,
      )
    ) {
      throw refusal(
        "saas_normalization_write_drift",
        `Month ${claim.month} did not store exactly the computed v1 row set.`,
        "Retry the request in Company Setup → SaaS Metrics; every metric write was rolled back and the attempt re-proves the month before any write.",
        { status: 409 },
      );
    }
    // Grain was proved equal above, so every rewritten row has exactly one
    // proved prior; a missing prior fails closed instead of recording an
    // added or removed correction.
    const requirePrior = <Key>(prior: Key | undefined, table: string, key: string): Key => {
      if (!prior) {
        throw refusal(
          "saas_normalization_grain_changed",
          `Month ${claim.month} changed membership during its correction (${table}:${key}).`,
          "Retry the request in Company Setup → SaaS Metrics; every metric write was rolled back and the attempt re-proves the month before any write.",
          { field: "month", status: 409 },
        );
      }
      return prior;
    };
    const beforeMonthlyByKey = new Map(before.monthly.map((row) => [row.subscriptionId, row]));
    const beforeFactsByKey = new Map(before.facts.map((row) => [row.subsidiaryId, row]));
    const beforeCohortsByKey = new Map(
      before.cohorts.map((row) => [`${row.subsidiaryId}:${row.cohortMonth}`, row]),
    );
    const seeds: CorrectionAuditSeed[] = [
      ...after.monthly.map((row): CorrectionAuditSeed => {
        const prior = requirePrior(
          beforeMonthlyByKey.get(row.subscriptionId),
          "saas_metrics_monthly",
          row.subscriptionId,
        );
        return {
          table: "saas_metrics_monthly",
          rowId: row.id,
          naturalKey: { subscriptionId: row.subscriptionId, month: row.month },
          change: "corrected",
          before: prior,
          after: row,
          sourceV0Hash: prior.inputsHash,
        };
      }),
      ...after.facts.map((row): CorrectionAuditSeed => {
        const prior = requirePrior(
          beforeFactsByKey.get(row.subsidiaryId),
          "saas_metrics_facts_monthly",
          row.subsidiaryId,
        );
        return {
          table: "saas_metrics_facts_monthly",
          rowId: row.id,
          naturalKey: { subsidiaryId: row.subsidiaryId, month: row.month },
          change: "corrected",
          before: prior,
          after: row,
          sourceV0Hash: prior.inputsHash,
        };
      }),
      ...after.cohorts.map((row): CorrectionAuditSeed => {
        const prior = requirePrior(
          beforeCohortsByKey.get(`${row.subsidiaryId}:${row.cohortMonth}`),
          "saas_metrics_cohort_monthly",
          `${row.subsidiaryId}:${row.cohortMonth}`,
        );
        return {
          table: "saas_metrics_cohort_monthly",
          rowId: row.id,
          naturalKey: {
            subsidiaryId: row.subsidiaryId,
            cohortMonth: row.cohortMonth,
            month: row.month,
          },
          change: "corrected",
          before: prior,
          after: row,
          sourceV0Hash: prior.inputsHash,
        };
      }),
    ];
    await writeCorrectionAudit(db, {
      orgId,
      requestId,
      idempotencyKey: claim.idempotencyKey,
      month: claim.month,
      attempt: claim.attempt,
      actor: claim.approvedBy,
      reason: claim.reason,
      monthHash: normalized.monthHash,
      seeds,
    });
    const result: NormalizationExecutionResult = {
      requestId,
      month: claim.month,
      attempt: claim.attempt,
      reportingCurrency: normalized.reportingCurrency,
      denominationVersion: SAAS_METRICS_DENOMINATION_VERSION,
      monthHash: normalized.monthHash,
      subscriptionRows: normalized.computed.rows.length,
      subsidiaryRows: normalized.facts.length,
      replacedMonthly: before.monthly.length,
      replacedFacts: before.facts.length,
      replacedCohorts: before.cohorts.length,
      sourceV0Hashes,
    };
    const finalized = await db.execute<{ id: string }>(
      sql`
      update saas_metrics_normalization_requests
         set status = 'succeeded', result = ${JSON.stringify(result)}::jsonb,
             progress = progress || '{"phase":"complete"}'::jsonb,
             updated_by = approved_by
       where org_id = ${orgId} and id = ${requestId} and status = 'running'
         and lease_token = ${leaseToken} and lease_expires_at > now()
      returning id
    `,
      "objects",
    );
    if (finalized.length !== 1) {
      await diagnoseFenceMiss(db, orgId, requestId);
    }
    return result;
  });
}

/**
 * Release a correction authorized by its tenant Flow policy and record the
 * first pending-to-running claim atomically in a single transaction, then
 * execute the fenced correction with the lease token held server-side. No
 * externally committed approved-but-unclaimed gap can exist through this
 * entrypoint: either both guarded statements commit together or the
 * concurrent loser refuses on zero rows. The raw token is never returned;
 * callers receive the request record and the recorded result only.
 * No separate approval, claim or token-bearing execution command is exposed.
 */
export async function approveAndExecuteNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  approverId: string;
  leaseTtlMinutes?: number;
  approvalRunId?: string;
}): Promise<{ request: NormalizationRequestRecord; result: NormalizationExecutionResult }> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const approverId = requireUuid(args.approverId, "approved_by");
  const ttlMinutes = args.leaseTtlMinutes ?? DEFAULT_LEASE_MINUTES;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw refusal(
      "saas_normalization_lease_ttl_invalid",
      "The lease duration must be between 1 and 1440 minutes.",
      "Request a lease of 1 to 1440 minutes when approving in Company Setup → SaaS Metrics.",
      { field: "leaseTtlMinutes" },
    );
  }
  const peek = await withOrgTransaction(orgId, async () => {
    await lockNormalizationOperator(orgId, approverId);
    return readRequest(db, orgId, requestId);
  });
  if (!peek) throw missingRequest(requestId);
  if (peek.status === "succeeded" && peek.result) {
    return { request: toRecord(peek), result: peek.result };
  }
  if (peek.status !== "pending") {
    throw refusal(
      "saas_normalization_approval_state",
      `Request ${requestId} is ${peek.status} and no longer accepts an approval.`,
      SETUP_LIST_REMEDY,
      { status: 409 },
    );
  }
  await withOrgTransaction(orgId, () =>
    requireNormalizationApproval(orgId, requestId, approverId, args.approvalRunId),
  );
  if (peek.approved_by !== null && peek.approved_by !== approverId) {
    throw refusal(
      "saas_normalization_approver_recorded",
      `Request ${requestId} already records approver ${peek.approved_by}; the recorded approval stands.`,
      SETUP_LIST_REMEDY,
      { field: "approved_by", status: 409 },
    );
  }
  const month = peek.month.slice(0, 10);
  const leaseToken = randomUUID();
  await withOrgTransaction(orgId, async () => {
    if (peek.approved_by === null) {
      const approved = await db.execute<{ id: string }>(
        sql`
        update saas_metrics_normalization_requests
           set approved_by = ${approverId}, approved_at = now(), updated_by = ${approverId}
         where org_id = ${orgId} and id = ${requestId} and status = 'pending' and approved_by is null
        returning id
      `,
        "objects",
      );
      if (approved.length !== 1) {
        const current = await readRequest(db, orgId, requestId);
        if (!current) throw missingRequest(requestId);
        if (current.approved_by !== null && current.approved_by !== approverId) {
          throw refusal(
            "saas_normalization_approver_recorded",
            `Request ${requestId} already records approver ${current.approved_by}; the recorded approval stands.`,
            SETUP_LIST_REMEDY,
            { field: "approved_by", status: 409 },
          );
        }
        throw refusal(
          "saas_normalization_approval_state",
          `Request ${requestId} is ${current.status} and no longer accepts an approval.`,
          current.status === "pending" ? SETUP_LIST_REMEDY : claimStateRemedy(toRecord(current)),
          { status: 409 },
        );
      }
    }
    const claimed = await db.execute<{ id: string }>(
      sql`
      update saas_metrics_normalization_requests
         set status = 'running', lease_token = ${leaseToken},
             lease_expires_at = now() + make_interval(mins => ${ttlMinutes}),
             attempt_count = attempt_count + 1,
             progress = progress || '{"phase":"claimed"}'::jsonb,
             updated_by = approved_by
       where org_id = ${orgId} and id = ${requestId} and status = 'pending'
      returning id
    `,
      "objects",
    );
    if (claimed.length !== 1) {
      const current = await readRequest(db, orgId, requestId);
      throw refusal(
        "saas_normalization_already_claimed",
        `Request ${requestId} was claimed concurrently and is no longer pending.`,
        current ? claimStateRemedy(toRecord(current)) : SETUP_LIST_REMEDY,
        { status: 409 },
      );
    }
  });
  try {
    const result = await runCorrectionAttempt(orgId, requestId, leaseToken, month, ttlMinutes);
    const record = await withOrgTransaction(orgId, async () => {
      const finished = await readRequest(db, orgId, requestId);
      if (!finished) throw missingRequest(requestId);
      return toRecord(finished);
    });
    return { request: record, result };
  } catch (error) {
    // Pre-claim fence and state refusals fire before any metric work starts,
    // so there is no failed outcome to record; everything after the live
    // claim — including a post-claim feature-off — records one under the
    // live lease.
    if (
      error instanceof UsageBillingError &&
      [
        "saas_normalization_request_missing",
        "saas_normalization_execute_state",
        "saas_normalization_execute_unapproved",
        "saas_normalization_lease_mismatch",
        "saas_normalization_lease_state",
        "saas_normalization_lease_live",
        "saas_normalization_month_mismatch",
      ].includes(error.code)
    ) {
      throw error;
    }
    const { failure, remedy, error: original } = toFailure(error, month);
    return await recordExecutionFailure({
      orgId,
      requestId,
      leaseToken,
      failure,
      remedy,
      original,
    });
  }
}

/**
 * Read-only per-month normalization state for the Company Setup → SaaS
 * Metrics workflow. This is the single classifier the workflow reads: one
 * engine query source unions the months from all three metric tables with
 * the request months, counts every row set, and maps each month to exactly
 * one of legacy, ready, pending, running, failed, or refused.
 *
 * The returned DTO is exhaustively whitelisted for the settings surface:
 * month, state, the three row counts, the denomination version and
 * reporting currency only when the stored rows coherently carry them, the
 * current request id and status, and operator-safe failure/remedy text.
 * Lease tokens and digests, request hashes, free-form reasons, progress
 * payloads, source hashes, and raw results or audit rows never leave this
 * function.
 *
 * Classification fails closed. Ready needs every stored row on the complete
 * v1 triple (reporting currency, denomination version, and evidence all
 * present) with one reporting currency, one canonical stored hash, and
 * every row's evidence hash equal to its own row hash, plus full agreement
 * with the succeeded result — same month, denomination, currency, recorded
 * month hash, and matching monthly, subsidiary, facts, and cohorts counts
 * — when a request selected the month. Legacy needs every
 * stored row on the all-null legacy triple. Empty months, mixed legacy/v1
 * sets, partial triples, unsupported versions, multiple currencies, and
 * malformed or mismatched results are refused by name with the request and
 * tenant Flow remedy — never silently labelled ready. A cancelled
 * request falls back to the stored-row classification while its token-free
 * identity stays visible. Terminal precedence is deterministic: the latest
 * non-cancelled request by creation time, id breaking ties, so an older
 * row can never shadow a later outcome.
 */
export type NormalizationMonthState =
  "legacy" | "ready" | "pending" | "running" | "failed" | "refused";

export interface NormalizationMonthRequest {
  id: string;
  status: NormalizationRequestStatus;
}

export interface NormalizationMonthStates {
  month: string;
  state: NormalizationMonthState;
  counts: { monthly: number; facts: number; cohorts: number };
  denominationVersion: string | null;
  reportingCurrency: string | null;
  request: NormalizationMonthRequest | null;
  failure: string | null;
  remedy: string | null;
}

type MonthShapeRow = {
  month: string;
  monthly: number;
  facts: number;
  cohorts: number;
  total: number;
  legacy: number;
  v1: number;
  currencies: string[];
  versions: string[];
  hashes: string[];
  evidenceHashes: string[];
  evidenceMismatch: number;
};

type MonthRequestRow = {
  id: string;
  month: string;
  status: NormalizationRequestStatus;
  createdAt: string;
  failure: string | null;
  remedy: string | null;
  result: unknown;
};

const MONTH_REQUEST_REMEDY =
  "Submit a normalization request for the month in Company Setup → SaaS Metrics and complete any tenant Flow gates; the released correction re-proves the stored rows before any write.";

function monthRequestState(
  month: string,
  shape: MonthShapeRow,
  terminal: MonthRequestRow | null,
  fallback: MonthRequestRow | null,
): NormalizationMonthStates {
  const base = {
    month,
    counts: { monthly: shape.monthly, facts: shape.facts, cohorts: shape.cohorts },
    denominationVersion: null as string | null,
    reportingCurrency: null as string | null,
    request: terminal
      ? { id: terminal.id, status: terminal.status }
      : fallback
        ? { id: fallback.id, status: fallback.status }
        : null,
    failure: null as string | null,
    remedy: null as string | null,
  };
  if (terminal && (terminal.status === "pending" || terminal.status === "running")) {
    return { ...base, state: terminal.status };
  }
  if (terminal && terminal.status === "failed") {
    return { ...base, state: "failed", failure: terminal.failure, remedy: terminal.remedy };
  }
  const coherentLegacy = shape.total > 0 && shape.legacy === shape.total;
  const singleHash = shape.hashes.length === 1 ? shape.hashes[0] : undefined;
  const singleEvidence = shape.evidenceHashes.length === 1 ? shape.evidenceHashes[0] : undefined;
  // A distinct aggregate cannot prove per-row agreement, and the mismatch
  // counter stays scoped to evidence-bearing rows: intentional all-null
  // legacy rows carry no evidence by design and must never read as
  // evidence tamper. Only rows that purport to carry normalization
  // evidence can disagree with their own row hash.
  const coherentHashes =
    singleHash !== undefined &&
    singleEvidence !== undefined &&
    singleEvidence === singleHash &&
    shape.evidenceMismatch === 0;
  // Shape first, coherence second: completeV1Shape says every stored row
  // is a complete v1 row under one currency (version and evidence
  // presence ride along with the v1 counter), while coherentHashes adds
  // the single canonical hash with per-row evidence binding. Ready needs
  // both; diagnosis names shape failures before hash failures.
  const completeV1Shape =
    shape.total > 0 &&
    shape.v1 === shape.total &&
    shape.currencies.length === 1 &&
    shape.currencies[0] !== undefined;
  const coherentV1 = completeV1Shape && coherentHashes;
  const describeShape = (): string => {
    if (shape.total === 0) return `Month ${month} has no stored metric rows.`;
    // An unsupported version outranks currency, shape, and hash
    // disagreement: the operator must fix the version first, and a
    // versioned row can never authenticate the set no matter what the
    // rest of the month says.
    const unsupported = shape.versions.filter((version) => version !== "v1");
    if (unsupported.length > 0) {
      return `Month ${month} carries an unsupported denomination version (${unsupported.join(", ")}).`;
    }
    if (shape.currencies.length > 1) {
      return `Month ${month} mixes reporting currencies (${shape.currencies.join(", ")}).`;
    }
    if (!coherentLegacy && !completeV1Shape) {
      return `Month ${month} mixes legacy and normalized rows or carries an incomplete denomination.`;
    }
    if (shape.hashes.length !== 1) {
      return `Month ${month} mixes stored row hashes, so no canonical month hash exists.`;
    }
    if (!coherentHashes) {
      return `Month ${month} carries evidence hashes that do not agree on the stored canonical hash.`;
    }
    return `Month ${month} cannot be classified from its stored rows.`;
  };
  if (terminal && terminal.status === "succeeded") {
    const result = terminal.result as Partial<NormalizationExecutionResult> | null;
    const storedHash = shape.hashes.length === 1 ? shape.hashes[0] : undefined;
    const evidenceHash = shape.evidenceHashes.length === 1 ? shape.evidenceHashes[0] : undefined;
    const detail: string[] = [];
    if (!completeV1Shape) {
      detail.push(describeShape());
    } else if (typeof result !== "object" || result === null) {
      detail.push(`the recorded result for ${month} is missing or malformed`);
    } else {
      if (result.month !== month) {
        detail.push(`the recorded result covers ${String(result.month)}, not ${month}`);
      }
      if (result.denominationVersion !== SAAS_METRICS_DENOMINATION_VERSION) {
        detail.push(`the recorded denomination ${String(result.denominationVersion)} is not v1`);
      }
      if (result.reportingCurrency !== shape.currencies[0]) {
        detail.push(
          `the recorded currency ${String(result.reportingCurrency)} does not match the stored ${String(shape.currencies[0])}`,
        );
      }
      if (storedHash === undefined || result.monthHash !== storedHash) {
        detail.push("the stored row hashes do not match the recorded month hash");
      }
      if (evidenceHash === undefined || evidenceHash !== storedHash) {
        detail.push("the stored evidence hashes do not agree on one canonical hash");
      }
      if (
        result.subscriptionRows !== shape.monthly ||
        result.subsidiaryRows !== shape.facts ||
        result.replacedMonthly !== shape.monthly ||
        result.replacedFacts !== shape.facts ||
        result.replacedCohorts !== shape.cohorts
      ) {
        detail.push(
          `the stored counts ${shape.monthly}/${shape.facts}/${shape.cohorts} do not match the recorded counts`,
        );
      }
    }
    if (detail.length === 0) {
      return {
        ...base,
        state: "ready",
        denominationVersion: SAAS_METRICS_DENOMINATION_VERSION,
        reportingCurrency: shape.currencies[0]!,
      };
    }
    return {
      ...base,
      state: "refused",
      failure:
        `Request ${terminal.id} succeeded for ${month}, but the stored rows no longer match its recorded result: ` +
        `${detail.join("; ")}.`,
      remedy: MONTH_REQUEST_REMEDY,
    };
  }
  if (coherentLegacy) return { ...base, state: "legacy" };
  if (coherentV1 && !terminal) {
    // Normalized by the shared pipeline with no request on record: there is
    // nothing to correct, so the month is ready. Refusing here would name a
    // remedy that can never succeed, because a request for v1 rows cannot
    // prove a legacy set.
    return {
      ...base,
      state: "ready",
      denominationVersion: SAAS_METRICS_DENOMINATION_VERSION,
      reportingCurrency: shape.currencies[0]!,
    };
  }
  return { ...base, state: "refused", failure: describeShape(), remedy: MONTH_REQUEST_REMEDY };
}

export async function listNormalizationMonthStates(
  orgId: string,
): Promise<NormalizationMonthStates[]> {
  const resolvedOrgId = requireUuid(orgId, "org_id");
  return withOrgTransaction(resolvedOrgId, async () => {
    await acquireOrgFeatureGateLock(db, resolvedOrgId);
    if (!(await lockAndCheckOrgFeature(db, resolvedOrgId, "saasMetrics"))) {
      throw refusal(
        "feature_off",
        "SaaS metrics are disabled for this organization.",
        FEATURES_REMEDY,
      );
    }
    const shapes = await db.execute<MonthShapeRow>(
      sql`
      with rows as (
        select month::text as month, reporting_currency, denomination_version, normalization_evidence,
               inputs_hash, 'monthly' as source
          from saas_metrics_monthly where org_id = ${resolvedOrgId}
        union all
        select month::text as month, reporting_currency, denomination_version, normalization_evidence,
               inputs_hash, 'facts' as source
          from saas_metrics_facts_monthly where org_id = ${resolvedOrgId}
        union all
        select month::text as month, reporting_currency, denomination_version, normalization_evidence,
               inputs_hash, 'cohorts' as source
          from saas_metrics_cohort_monthly where org_id = ${resolvedOrgId}
      ),
      months as (
        select month from rows group by month
        union
        select month::text as month from saas_metrics_normalization_requests where org_id = ${resolvedOrgId}
      )
      select m.month as month,
             coalesce(sum(case when r.source = 'monthly' then 1 else 0 end), 0)::int as monthly,
             coalesce(sum(case when r.source = 'facts' then 1 else 0 end), 0)::int as facts,
             coalesce(sum(case when r.source = 'cohorts' then 1 else 0 end), 0)::int as cohorts,
             count(r.source)::int as total,
             coalesce(sum(case when r.reporting_currency is null
                                and r.denomination_version is null
                                and r.normalization_evidence is null then 1 else 0 end), 0)::int as legacy,
             coalesce(sum(case when r.reporting_currency is not null
                                and r.denomination_version = ${SAAS_METRICS_DENOMINATION_VERSION}
                                and r.normalization_evidence is not null
                                then 1 else 0 end), 0)::int as v1,
             coalesce(array_remove(array_agg(distinct r.reporting_currency), null), '{}') as currencies,
             coalesce(array_remove(array_agg(distinct r.denomination_version), null), '{}') as versions,
             coalesce(array_remove(array_agg(distinct r.inputs_hash), null), '{}') as hashes,
             coalesce(array_remove(array_agg(distinct (r.normalization_evidence ->> 'inputs_hash')), null), '{}')
               as "evidenceHashes",
             coalesce(sum(case when r.normalization_evidence is not null
                                and (r.normalization_evidence ->> 'inputs_hash') is distinct from r.inputs_hash
                                then 1 else 0 end), 0)::int as "evidenceMismatch"
        from months m left join rows r on r.month = m.month
       group by m.month order by m.month desc
    `,
      "objects",
    );
    const requests = await db.execute<MonthRequestRow>(
      sql`
      select id::text as id, month::text as month, status,
             created_at::text as "createdAt", failure, remedy, result
        from saas_metrics_normalization_requests
       where org_id = ${resolvedOrgId}
       order by month desc, created_at desc, id desc
    `,
      "objects",
    );
    const byMonth = new Map<string, MonthRequestRow[]>();
    for (const row of requests) {
      const key = row.month.slice(0, 10);
      const list = byMonth.get(key);
      if (list) list.push(row);
      else byMonth.set(key, [row]);
    }
    const later = (a: MonthRequestRow, b: MonthRequestRow): boolean =>
      a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
    return shapes.map((shape) => {
      const month = shape.month.slice(0, 10);
      const history = (byMonth.get(month) ?? []).slice().sort((a, b) => (later(a, b) ? -1 : 1));
      const terminal = history.find((row) => row.status !== "cancelled") ?? null;
      const fallback = terminal ? null : (history[0] ?? null);
      return monthRequestState(month, shape, terminal, fallback);
    });
  });
}

async function lockNormalizationOperator(orgId: string, actorId: string): Promise<void> {
  const allowed = await lockActorCommandAuthority(db, orgId, actorId, null, "usage.manage");
  if (allowed !== null) throw new ScopeNotFoundError();
}

async function requireNormalizationApproval(
  orgId: string,
  requestId: string,
  actorId: string,
  approvalRunId?: string,
): Promise<void> {
  await lockNormalizationOperator(orgId, actorId);
  const decision = await readNativeApprovalDecision({
    orgId,
    actorId,
    subjectKind: "metrics_normalization",
    subjectId: requestId,
    outcome: "approved",
    approvalRunId,
  });
  const ungated =
    !approvalRunId &&
    (
      await db.execute<{ allowed: boolean }>(
        sql`select public.normalization_request_flow_authorized(${orgId},${requestId},${actorId},'approved') as allowed`,
        "objects",
      )
    )[0]?.allowed === true;
  if (!decision && !ungated)
    throw refusal(
      "saas_normalization_approval_required",
      "Complete the tenant's native Flow gates before executing this correction.",
      "Open the pending SaaS metrics correction in Approvals.",
      { status: 409 },
    );
}

export async function releaseNormalizationApproval(args: {
  subjectId: string;
  outcome: "approved" | "rejected";
  approvalRunId?: string;
  comment?: string | null;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  const actorId = args.ctx.userId;
  if (!actorId) throw new Error("A metrics correction requires a named operator.");
  const orgId = args.ctx.orgId,
    requestId = args.subjectId;
  const decision = await readNativeApprovalDecision({
    orgId,
    actorId,
    subjectKind: "metrics_normalization",
    subjectId: requestId,
    outcome: args.outcome,
    approvalRunId: args.approvalRunId,
  });
  if (!decision)
    throw refusal(
      "saas_normalization_approval_required",
      "Complete the native Flow gate before deciding this correction.",
      "Use the pending correction Flow gate.",
      { status: 409 },
    );
  if (args.outcome === "approved") {
    await approveAndExecuteNormalizationRequest({
      orgId,
      requestId,
      approverId: actorId,
      approvalRunId: args.approvalRunId,
    });
    return;
  }
  await lockNormalizationOperator(orgId, actorId);
  const changed = await db.execute(
    sql`update saas_metrics_normalization_requests set status='cancelled',updated_by=${actorId}
    where org_id=${orgId} and id=${requestId} and status='pending' returning id`,
    "objects",
  );
  if (changed.length !== 1) throw missingRequest(requestId);
}
