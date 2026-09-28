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
  computeNormalizedMetricsMonth,
  readStoredMetricsMonth,
  writeNormalizedMetricsMonth,
  type StoredMetricsMonth,
} from "./metrics-ledger.ts";

/**
 * Audited two-person normalization service for SaaS metrics.
 *
 * Normal recompute stays frozen for closed months. The only path that may
 * replace legacy rows — including rows in a closed month — is an approved
 * correction request executed here: exactly one org and month per request,
 * a requester who cannot approve their own request, a fenced lease token
 * that serializes workers, a byte-for-byte proof of the legacy row set
 * before any write, the same v1 computation and writers the ordinary
 * recompute uses, per-row before/after evidence in the canonical audit_log,
 * and a fenced terminal finalization. There is no normalization_attempts
 * table: the request row owns current fenced liveness and the append-only
 * audit_log owns typed attempt transitions plus per-row correction history.
 * Raw lease tokens never enter audit; only their digests do.
 */

const FEATURES_REMEDY = "Enable SaaS metrics in Company Settings → Features.";
const SETUP_LIST_REMEDY = "Open Company Setup → SaaS Metrics to review the request and its recorded result.";
const DEFAULT_LEASE_MINUTES = 10;

export type NormalizationRequestStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

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
function requestBodyHash(args: { orgId: string; month: string; reason: string; requestedBy: string }): string {
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
  const rows = (await executor.execute<RequestRow>(sql`
    select ${REQUEST_COLUMNS}
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and id = ${requestId}
  `)).rows;
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
  return `Request ${existing.id} for ${existing.month} is already ${existing.status}. ` +
    "Wait for it to finish, cancel it, or open it in Company Setup → SaaS Metrics to follow its progress.";
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
    const attemptInsert = async (): Promise<{ request: NormalizationRequestRecord; created: boolean } | null> => {
      try {
        const inserted = (await db.execute<RequestRow>(sql`
          insert into saas_metrics_normalization_requests
            (org_id, month, reason, requested_by, idempotency_key, request_hash, created_by, updated_by)
          values (${orgId}, ${month}::date, ${reason}, ${requestedBy}, ${idempotencyKey}, ${bodyHash},
                  ${requestedBy}, ${requestedBy})
          returning ${REQUEST_COLUMNS}
        `)).rows;
        if (inserted.length !== 1 || !inserted[0]) {
          throw refusal(
            "saas_normalization_request_write_missing",
            `Normalization request for ${month} was not stored.`,
            "Confirm the organization still exists in Company Setup → SaaS Metrics, then submit again.",
          );
        }
        return { request: toRecord(inserted[0]!), created: true };
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== "23505") throw error;
        return null;
      }
    };
    const replayOrRefuse = async (): Promise<{ request: NormalizationRequestRecord; created: boolean }> => {
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
  const rows = (await executor.execute<RequestRow>(sql`
    select ${REQUEST_COLUMNS}
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and idempotency_key = ${idempotencyKey}
  `)).rows;
  return rows[0] ?? null;
}

async function readLiveRequest(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<RequestRow | null> {
  const rows = (await executor.execute<RequestRow>(sql`
    select ${REQUEST_COLUMNS}
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and month = ${month}::date and status in ('pending', 'running')
  `)).rows;
  return rows[0] ?? null;
}

/**
 * Record a distinct approver on a pending request. Self-approval refuses
 * even when the actor holds every permission; permission checks themselves
 * stay at the E boundary. Re-approval by the recorded approver replays.
 */
export async function approveNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  approverId: string;
}): Promise<NormalizationRequestRecord> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const approverId = requireUuid(args.approverId, "approved_by");
  return withOrgTransaction(orgId, async () => {
    const existing = await readRequest(db, orgId, requestId);
    if (!existing) throw missingRequest(requestId);
    if (approverId === existing.requested_by) {
      throw refusal(
        "saas_normalization_self_approval",
        `Request ${requestId} cannot be approved by its requester.`,
        "Have a different authorized approver approve the request in Company Setup → SaaS Metrics.",
        { field: "approved_by", status: 409 },
      );
    }
    if (existing.status !== "pending") {
      throw refusal(
        "saas_normalization_approval_state",
        `Request ${requestId} is ${existing.status} and no longer accepts an approval.`,
        SETUP_LIST_REMEDY,
        { status: 409 },
      );
    }
    if (existing.approved_by !== null) {
      if (existing.approved_by === approverId) return toRecord(existing);
      throw refusal(
        "saas_normalization_approver_recorded",
        `Request ${requestId} already records approver ${existing.approved_by}; the recorded approval stands.`,
        SETUP_LIST_REMEDY,
        { field: "approved_by", status: 409 },
      );
    }
    const updated = (await db.execute<RequestRow>(sql`
      update saas_metrics_normalization_requests
         set approved_by = ${approverId}, approved_at = now(), updated_by = ${approverId}
       where org_id = ${orgId} and id = ${requestId} and status = 'pending'
      returning ${REQUEST_COLUMNS}
    `)).rows;
    if (updated.length !== 1 || !updated[0]) {
      throw refusal(
        "saas_normalization_approval_write_missing",
        `Approval for request ${requestId} was not recorded.`,
        SETUP_LIST_REMEDY,
        { status: 409 },
      );
    }
    return toRecord(updated[0]!);
  });
}

/**
 * Atomically claim a pending approved request into running with a fresh
 * cryptographically random lease token. A second concurrent first claim
 * matches zero rows and receives the already-claimed remedy instead.
 */
export async function claimNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  leaseTtlMinutes?: number;
}): Promise<{ request: NormalizationRequestRecord; leaseToken: string }> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const ttlMinutes = args.leaseTtlMinutes ?? DEFAULT_LEASE_MINUTES;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw refusal(
      "saas_normalization_lease_ttl_invalid",
      "The lease duration must be between 1 and 1440 minutes.",
      "Request a lease of 1 to 1440 minutes when claiming in Company Setup → SaaS Metrics.",
      { field: "leaseTtlMinutes" },
    );
  }
  const leaseToken = randomUUID();
  return withOrgTransaction(orgId, async () => {
    const existing = await readRequest(db, orgId, requestId);
    if (!existing) throw missingRequest(requestId);
    if (existing.status !== "pending") {
      throw refusal(
        "saas_normalization_already_claimed",
        `Request ${requestId} is ${existing.status}; the first claim already ran.`,
        liveRequestRemedy(toRecord(existing)),
        { status: 409 },
      );
    }
    if (existing.approved_by === null) {
      throw refusal(
        "saas_normalization_claim_unapproved",
        `Request ${requestId} has no recorded approval and cannot be claimed.`,
        "Record a distinct approver on the pending request in Company Setup → SaaS Metrics, then claim.",
        { status: 409 },
      );
    }
    const updated = (await db.execute<RequestRow>(sql`
      update saas_metrics_normalization_requests
         set status = 'running', lease_token = ${leaseToken},
             lease_expires_at = now() + make_interval(mins => ${ttlMinutes}),
             attempt_count = attempt_count + 1,
             progress = progress || '{"phase":"claimed"}'::jsonb,
             updated_by = approved_by
       where org_id = ${orgId} and id = ${requestId} and status = 'pending'
      returning ${REQUEST_COLUMNS}
    `)).rows;
    if (updated.length !== 1 || !updated[0]) {
      const current = await readRequest(db, orgId, requestId);
      throw refusal(
        "saas_normalization_already_claimed",
        `Request ${requestId} was claimed concurrently and is no longer pending.`,
        current ? liveRequestRemedy(toRecord(current)) : SETUP_LIST_REMEDY,
        { status: 409 },
      );
    }
    return { request: toRecord(updated[0]!), leaseToken };
  });
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
        ? "Retry the failed request in Company Setup → SaaS Metrics to open a fresh lease, then continue."
        : SETUP_LIST_REMEDY,
      { status: 409 },
    );
  }
  const expiry = (await executor.execute<{ expired: boolean }>(sql`
    select lease_expires_at <= now() as expired
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and id = ${requestId}
  `)).rows[0]?.expired ?? true;
  throw refusal(
    "saas_normalization_lease_mismatch",
    `The presented lease token does not match the live lease for request ${requestId}.`,
    expiry
      ? "The lease has expired. Reacquire the request with a fresh token in Company Setup → SaaS Metrics, then continue."
      : "Heartbeat with the live token held by the current worker, or wait for expiry and reacquire with a fresh token in Company Setup → SaaS Metrics.",
    { field: "leaseToken", status: 409 },
  );
}

/**
 * Heartbeat under the live lease token: extends the expiry and optionally
 * records progress. Heartbeats manufacture no attempt audit event. An
 * expired, wrong, or stale token matches zero rows and refuses by name.
 */
export async function heartbeatNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  leaseToken: string;
  progress?: Record<string, unknown>;
  leaseTtlMinutes?: number;
}): Promise<NormalizationRequestRecord> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const leaseToken = requireUuid(args.leaseToken, "lease_token");
  const ttlMinutes = args.leaseTtlMinutes ?? DEFAULT_LEASE_MINUTES;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw refusal(
      "saas_normalization_lease_ttl_invalid",
      "The lease duration must be between 1 and 1440 minutes.",
      "Request a lease of 1 to 1440 minutes when heartbeating in Company Setup → SaaS Metrics.",
      { field: "leaseTtlMinutes" },
    );
  }
  if (args.progress !== undefined && (args.progress === null || typeof args.progress !== "object" || Array.isArray(args.progress))) {
    throw refusal(
      "saas_normalization_progress_invalid",
      "Heartbeat progress must be a JSON object.",
      "Send progress as a JSON object, or omit it, in Company Setup → SaaS Metrics.",
      { field: "progress" },
    );
  }
  return withOrgTransaction(orgId, async () => {
    const updated = (await db.execute<RequestRow>(sql`
      update saas_metrics_normalization_requests
         set lease_expires_at = greatest(lease_expires_at, now() + make_interval(mins => ${ttlMinutes})),
             progress = ${args.progress === undefined ? sql`progress` : sql`progress || ${JSON.stringify(args.progress)}::jsonb`},
             updated_by = approved_by
       where org_id = ${orgId} and id = ${requestId} and status = 'running'
         and lease_token = ${leaseToken} and lease_expires_at > now()
      returning ${REQUEST_COLUMNS}
    `)).rows;
    if (updated.length !== 1 || !updated[0]) {
      await diagnoseFenceMiss(db, orgId, requestId);
    }
    return toRecord(updated[0]!);
  });
}

/**
 * Reacquire a running request only after its lease expired, with a fresh
 * token and a new attempt. A live lease refuses visibly; the caller must
 * heartbeat with the live token or wait for expiry. The executor reruns
 * the complete v0 proof before any metric write on the new attempt.
 */
export async function reacquireNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  leaseTtlMinutes?: number;
}): Promise<{ request: NormalizationRequestRecord; leaseToken: string }> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const ttlMinutes = args.leaseTtlMinutes ?? DEFAULT_LEASE_MINUTES;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw refusal(
      "saas_normalization_lease_ttl_invalid",
      "The lease duration must be between 1 and 1440 minutes.",
      "Request a lease of 1 to 1440 minutes when reacquiring in Company Setup → SaaS Metrics.",
      { field: "leaseTtlMinutes" },
    );
  }
  const leaseToken = randomUUID();
  return withOrgTransaction(orgId, async () => {
    const existing = await readRequest(db, orgId, requestId);
    if (!existing) throw missingRequest(requestId);
    if (existing.status !== "running") {
      throw refusal(
        "saas_normalization_reacquire_state",
        `Request ${requestId} is ${existing.status}; only a running request with an expired lease can be reacquired.`,
        existing.status === "failed"
          ? "Retry the failed request in Company Setup → SaaS Metrics to open a fresh lease."
          : SETUP_LIST_REMEDY,
        { status: 409 },
      );
    }
    const updated = (await db.execute<RequestRow>(sql`
      update saas_metrics_normalization_requests
         set lease_token = ${leaseToken},
             lease_expires_at = now() + make_interval(mins => ${ttlMinutes}),
             attempt_count = attempt_count + 1,
             progress = progress || '{"phase":"reacquired"}'::jsonb,
             updated_by = approved_by
       where org_id = ${orgId} and id = ${requestId} and status = 'running'
         and lease_expires_at <= now()
      returning ${REQUEST_COLUMNS}
    `)).rows;
    if (updated.length !== 1 || !updated[0]) {
      throw refusal(
        "saas_normalization_lease_live",
        `The lease for request ${requestId} is still live; it cannot be reacquired.`,
        "Heartbeat with the live token held by the current worker, or wait for expiry and reacquire with a fresh token in Company Setup → SaaS Metrics.",
        { status: 409 },
      );
    }
    return { request: toRecord(updated[0]!), leaseToken };
  });
}

/** Retry a failed request into running with a fresh lease; the retry re-proves v0 before any write. */
export async function retryNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  leaseTtlMinutes?: number;
}): Promise<{ request: NormalizationRequestRecord; leaseToken: string }> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const ttlMinutes = args.leaseTtlMinutes ?? DEFAULT_LEASE_MINUTES;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw refusal(
      "saas_normalization_lease_ttl_invalid",
      "The lease duration must be between 1 and 1440 minutes.",
      "Request a lease of 1 to 1440 minutes when retrying in Company Setup → SaaS Metrics.",
      { field: "leaseTtlMinutes" },
    );
  }
  const leaseToken = randomUUID();
  return withOrgTransaction(orgId, async () => {
    const existing = await readRequest(db, orgId, requestId);
    if (!existing) throw missingRequest(requestId);
    if (existing.status !== "failed") {
      throw refusal(
        "saas_normalization_retry_state",
        `Request ${requestId} is ${existing.status}; only a failed request can be retried.`,
        SETUP_LIST_REMEDY,
        { status: 409 },
      );
    }
    const updated = (await db.execute<RequestRow>(sql`
      update saas_metrics_normalization_requests
         set status = 'running', lease_token = ${leaseToken},
             lease_expires_at = now() + make_interval(mins => ${ttlMinutes}),
             attempt_count = attempt_count + 1,
             progress = progress || '{"phase":"retried"}'::jsonb,
             result = null, failure = null, remedy = null,
             updated_by = approved_by
       where org_id = ${orgId} and id = ${requestId} and status = 'failed'
      returning ${REQUEST_COLUMNS}
    `)).rows;
    if (updated.length !== 1 || !updated[0]) {
      throw refusal(
        "saas_normalization_retry_write_missing",
        `Retry for request ${requestId} was not recorded.`,
        SETUP_LIST_REMEDY,
        { status: 409 },
      );
    }
    return { request: toRecord(updated[0]!), leaseToken };
  });
}

/** Cancel a pending request (requester) or a running/failed one (approver, live lease for running). */
export async function cancelNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  leaseToken?: string;
}): Promise<NormalizationRequestRecord> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const actorId = requireUuid(args.actorId, "actor_id");
  const leaseToken = args.leaseToken === undefined ? undefined : requireUuid(args.leaseToken, "lease_token");
  return withOrgTransaction(orgId, async () => {
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
      const updated = (await db.execute<RequestRow>(sql`
        update saas_metrics_normalization_requests
           set status = 'cancelled', updated_by = ${actorId}
         where org_id = ${orgId} and id = ${requestId} and status = 'pending'
        returning ${REQUEST_COLUMNS}
      `)).rows;
      if (updated.length !== 1 || !updated[0]) throw missingRequest(requestId);
      return toRecord(updated[0]!);
    }
    if (existing.status === "running" || existing.status === "failed") {
      if (actorId !== existing.approved_by) {
        throw refusal(
          "saas_normalization_cancel_forbidden",
          `Only the recorded approver can cancel ${existing.status} request ${requestId}.`,
          "Have the recorded approver cancel it in Company Setup → SaaS Metrics.",
          { status: 409 },
        );
      }
      if (existing.status === "running") {
        if (leaseToken === undefined) {
          throw refusal(
            "saas_normalization_cancel_lease_missing",
            `Cancelling running request ${requestId} needs the live lease token.`,
            "Heartbeat or reacquire first in Company Setup → SaaS Metrics, then cancel with the live token.",
            { field: "leaseToken", status: 409 },
          );
        }
        const updated = (await db.execute<RequestRow>(sql`
          update saas_metrics_normalization_requests
             set status = 'cancelled', updated_by = approved_by
           where org_id = ${orgId} and id = ${requestId} and status = 'running'
             and lease_token = ${leaseToken} and lease_expires_at > now()
          returning ${REQUEST_COLUMNS}
        `)).rows;
        if (updated.length !== 1 || !updated[0]) {
          await diagnoseFenceMiss(db, orgId, requestId);
        }
        return toRecord(updated[0]!);
      }
      const updated = (await db.execute<RequestRow>(sql`
        update saas_metrics_normalization_requests
           set status = 'cancelled', updated_by = approved_by
         where org_id = ${orgId} and id = ${requestId} and status = 'failed'
        returning ${REQUEST_COLUMNS}
      `)).rows;
      if (updated.length !== 1 || !updated[0]) {
        throw refusal(
          "saas_normalization_cancel_write_missing",
          `Cancellation for request ${requestId} was not recorded.`,
          SETUP_LIST_REMEDY,
          { status: 409 },
        );
      }
      return toRecord(updated[0]!);
    }
    throw refusal(
      "saas_normalization_cancel_state",
      `Request ${requestId} is ${existing.status} and cannot be cancelled; terminal rows are immutable.`,
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
): Promise<{ kind: "replay"; result: NormalizationExecutionResult } | { kind: "live"; claim: LiveClaim }> {
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
        ? "Record a distinct approval and claim the request in Company Setup → SaaS Metrics, then execute."
        : existing.status === "failed"
          ? "Retry the failed request in Company Setup → SaaS Metrics to open a fresh lease, then execute."
          : SETUP_LIST_REMEDY,
      { status: 409 },
    );
  }
  const claimed = (await executor.execute<{
    month: string; attempt_count: number; approved_by: string; reason: string; idempotency_key: string;
  }>(sql`
    update saas_metrics_normalization_requests
       set lease_expires_at = greatest(lease_expires_at, now() + make_interval(mins => ${ttlMinutes})),
           progress = progress || '{"phase":"executing"}'::jsonb,
           updated_by = approved_by
     where org_id = ${orgId} and id = ${requestId} and status = 'running'
       and lease_token = ${leaseToken} and lease_expires_at > now()
    returning month::text as month, attempt_count, approved_by::text as approved_by,
              reason, idempotency_key::text as idempotency_key
  `)).rows;
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
  const updated = (await executor.execute<{ id: string }>(sql`
    update saas_metrics_normalization_requests
       set progress = progress || ${JSON.stringify(progress)}::jsonb,
           updated_by = approved_by
     where org_id = ${orgId} and id = ${requestId} and status = 'running'
       and lease_token = ${leaseToken} and lease_expires_at > now()
    returning id
  `)).rows;
  if (updated.length !== 1) {
    await diagnoseFenceMiss(executor, orgId, requestId);
  }
}

/**
 * The v0 proof: reproduce the legacy row set byte-for-byte from unchanged
 * sources before any metric write. Every stored row must still be legacy
 * (all three reporting columns null); a fully normalized month replays as
 * already done, and a mixed month refuses as unsupported partial
 * normalization. An empty month has nothing to correct.
 */
function proveLegacyMonth(before: StoredMetricsMonth, month: string): string[] {
  const all = [...before.monthly, ...before.facts, ...before.cohorts];
  if (all.length === 0) {
    throw refusal(
      "saas_normalization_nothing_to_correct",
      `Month ${month} holds no stored metrics rows, so there is nothing to normalize.`,
      "Recompute the month through the ordinary SaaS metrics recompute, which writes normalized rows directly.",
      { field: "month", status: 409 },
    );
  }
  const isLegacy = (row: { reportingCurrency: string | null; denominationVersion: string | null }): boolean =>
    row.reportingCurrency === null && row.denominationVersion === null;
  const legacy = all.filter(isLegacy);
  if (legacy.length === all.length) return [...new Set(all.map((row) => row.inputsHash))];
  const complete = all.filter((row) => row.reportingCurrency !== null && row.denominationVersion !== null);
  if (complete.length === all.length) {
    throw refusal(
      "saas_normalization_already_normalized",
      `Month ${month} already carries normalized denomination evidence; no correction is needed.`,
      "Open the original succeeded request in Company Setup → SaaS Metrics for its recorded result.",
      { field: "month", status: 409 },
    );
  }
  throw refusal(
    "saas_normalization_partial_denominations",
    `Month ${month} mixes legacy and normalized rows, which one request cannot reconcile.`,
    "Open Company Setup → SaaS Metrics and review the month's recorded rows; restore a uniform row set, then file a new request.",
    { field: "month", status: 409 },
  );
}

type CorrectionAuditSeed = {
  table: string;
  rowId: string;
  naturalKey: Record<string, unknown>;
  change: "corrected" | "added" | "removed";
  before: unknown;
  after: unknown;
  sourceV0Hash: string | null;
};

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
    const inserted = (await executor.execute<{ id: string }>(sql`
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
    `)).rows;
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

function toFailure(error: unknown, month: string): { failure: string; remedy: string; error: UsageBillingError } {
  if (error instanceof UsageBillingError) {
    return { failure: `[${error.code}] ${error.message}`, remedy: error.remedy, error };
  }
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = refusal(
    "saas_normalization_execution_failed",
    `Normalization execution for ${month} stopped before any metric change was kept: ${detail}`,
    "Review the failure detail, correct the cause, then retry the request in Company Setup → SaaS Metrics; the month's stored rows are unchanged.",
  );
  return { failure: `[saas_normalization_execution_failed] ${wrapped.message}`, remedy: wrapped.remedy, error: wrapped };
}

/**
 * Record a guarded failed outcome under the live lease in a fresh
 * transaction (the attempt transaction already rolled back). If the fence
 * misses — the lease expired or a reacquire superseded this worker — the
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
      const updated = (await db.execute<{ id: string }>(sql`
        update saas_metrics_normalization_requests
           set status = 'failed', failure = ${args.failure}, remedy = ${args.remedy},
               progress = progress || '{"phase":"failed"}'::jsonb,
               updated_by = approved_by
         where org_id = ${args.orgId} and id = ${args.requestId} and status = 'running'
           and lease_token = ${args.leaseToken} and lease_expires_at > now()
        returning id
      `)).rows;
      if (updated.length !== 1) {
        await diagnoseFenceMiss(db, args.orgId, args.requestId);
      }
    });
  } catch (recordError) {
    if (recordError instanceof UsageBillingError && recordError.code.startsWith("saas_normalization_lease")) {
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
 * Execute one fenced correction attempt in a single transaction: authorize
 * under the live lease, take the feature-gate lock and recheck the gate,
 * take the org/month correction lock, prove the legacy month byte-for-byte,
 * compute through the shared v1 pipeline, replace that month's three row
 * sets atomically, record per-row before/after evidence, and finalize
 * succeeded under the live token. Any drift rolls every metric write back;
 * the caller records the guarded failed outcome outside this transaction.
 */
async function runCorrectionAttempt(
  orgId: string,
  requestId: string,
  leaseToken: string,
  ttlMinutes: number,
): Promise<NormalizationExecutionResult> {
  return withOrgTransaction(orgId, async () => {
    // Read the month first: the lock key derives from it, and every
    // authorization decision below still goes through the fenced claim.
    const peek = await readRequest(db, orgId, requestId);
    if (!peek) throw missingRequest(requestId);
    if (peek.status === "succeeded" && peek.result) return peek.result;
    const month = peek.month.slice(0, 10);
    // Keel order: the org feature-gate fence first with its recheck, then
    // the deterministic org/month correction lock, before any proof, read,
    // or write. One transaction executor holds both to commit.
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "saasMetrics"))) {
      throw refusal("feature_off", "SaaS metrics are disabled for this organization.", FEATURES_REMEDY);
    }
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${normalizationMonthLockKey(orgId, month)}, 0))`,
    );
    const assertion = await assertLiveClaim(db, orgId, requestId, leaseToken, ttlMinutes);
    if (assertion.kind === "replay") return assertion.result;
    const { claim } = assertion;
    const before = await readStoredMetricsMonth(db, orgId, claim.month);
    const sourceV0Hashes = proveLegacyMonth(before, claim.month);
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
    // Atomic replacement inside the transaction: the proven rows leave
    // first with exact-count deletes, then the shared writers store v1.
    // A closed month is corrected here only under this approved request;
    // the accounting period itself is never reopened and posted history is
    // never reversed or rewritten.
    const deletedMonthly = (await db.execute<{ id: string }>(sql`
      delete from saas_metrics_monthly
       where org_id = ${orgId} and month = ${claim.month}::date returning id
    `)).rows;
    const deletedFacts = (await db.execute<{ id: string }>(sql`
      delete from saas_metrics_facts_monthly
       where org_id = ${orgId} and month = ${claim.month}::date returning id
    `)).rows;
    const deletedCohorts = (await db.execute<{ id: string }>(sql`
      delete from saas_metrics_cohort_monthly
       where org_id = ${orgId} and month = ${claim.month}::date returning id
    `)).rows;
    if (
      deletedMonthly.length !== before.monthly.length
      || deletedFacts.length !== before.facts.length
      || deletedCohorts.length !== before.cohorts.length
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
      after.monthly.length !== normalized.computed.rows.length
      || after.facts.length !== normalized.facts.length
      || after.cohorts.length !== normalized.cohorts.length
      || ![...after.monthly, ...after.facts, ...after.cohorts].every(
        (row) =>
          row.inputsHash === normalized.monthHash
          && row.reportingCurrency === normalized.reportingCurrency
          && row.denominationVersion === SAAS_METRICS_DENOMINATION_VERSION,
      )
    ) {
      throw refusal(
        "saas_normalization_write_drift",
        `Month ${claim.month} did not store exactly the computed v1 row set.`,
        "Retry the request in Company Setup → SaaS Metrics; every metric write was rolled back and the attempt re-proves the month before any write.",
        { status: 409 },
      );
    }
    const beforeMonthlyByKey = new Map(before.monthly.map((row) => [row.subscriptionId, row]));
    const beforeFactsByKey = new Map(before.facts.map((row) => [row.subsidiaryId, row]));
    const beforeCohortsByKey = new Map(before.cohorts.map((row) => [`${row.subsidiaryId}:${row.cohortMonth}`, row]));
    const afterMonthlyKeys = new Set(after.monthly.map((row) => row.subscriptionId));
    const afterFactsKeys = new Set(after.facts.map((row) => row.subsidiaryId));
    const afterCohortKeys = new Set(after.cohorts.map((row) => `${row.subsidiaryId}:${row.cohortMonth}`));
    const seeds: CorrectionAuditSeed[] = [
      ...after.monthly.map((row): CorrectionAuditSeed => {
        const prior = beforeMonthlyByKey.get(row.subscriptionId) ?? null;
        return {
          table: "saas_metrics_monthly",
          rowId: row.id,
          naturalKey: { subscriptionId: row.subscriptionId, month: row.month },
          change: prior ? "corrected" : "added",
          before: prior,
          after: row,
          sourceV0Hash: prior?.inputsHash ?? null,
        };
      }),
      ...after.facts.map((row): CorrectionAuditSeed => {
        const prior = beforeFactsByKey.get(row.subsidiaryId) ?? null;
        return {
          table: "saas_metrics_facts_monthly",
          rowId: row.id,
          naturalKey: { subsidiaryId: row.subsidiaryId, month: row.month },
          change: prior ? "corrected" : "added",
          before: prior,
          after: row,
          sourceV0Hash: prior?.inputsHash ?? null,
        };
      }),
      ...after.cohorts.map((row): CorrectionAuditSeed => {
        const prior = beforeCohortsByKey.get(`${row.subsidiaryId}:${row.cohortMonth}`) ?? null;
        return {
          table: "saas_metrics_cohort_monthly",
          rowId: row.id,
          naturalKey: { subsidiaryId: row.subsidiaryId, cohortMonth: row.cohortMonth, month: row.month },
          change: prior ? "corrected" : "added",
          before: prior,
          after: row,
          sourceV0Hash: prior?.inputsHash ?? null,
        };
      }),
      ...before.monthly
        .filter((row) => !afterMonthlyKeys.has(row.subscriptionId))
        .map((row): CorrectionAuditSeed => ({
          table: "saas_metrics_monthly",
          rowId: row.id,
          naturalKey: { subscriptionId: row.subscriptionId, month: row.month },
          change: "removed",
          before: row,
          after: null,
          sourceV0Hash: row.inputsHash,
        })),
      ...before.facts
        .filter((row) => !afterFactsKeys.has(row.subsidiaryId))
        .map((row): CorrectionAuditSeed => ({
          table: "saas_metrics_facts_monthly",
          rowId: row.id,
          naturalKey: { subsidiaryId: row.subsidiaryId, month: row.month },
          change: "removed",
          before: row,
          after: null,
          sourceV0Hash: row.inputsHash,
        })),
      ...before.cohorts
        .filter((row) => !afterCohortKeys.has(`${row.subsidiaryId}:${row.cohortMonth}`))
        .map((row): CorrectionAuditSeed => ({
          table: "saas_metrics_cohort_monthly",
          rowId: row.id,
          naturalKey: { subsidiaryId: row.subsidiaryId, cohortMonth: row.cohortMonth, month: row.month },
          change: "removed",
          before: row,
          after: null,
          sourceV0Hash: row.inputsHash,
        })),
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
    const finalized = (await db.execute<{ id: string }>(sql`
      update saas_metrics_normalization_requests
         set status = 'succeeded', result = ${JSON.stringify(result)}::jsonb,
             progress = progress || '{"phase":"complete"}'::jsonb,
             updated_by = approved_by
       where org_id = ${orgId} and id = ${requestId} and status = 'running'
         and lease_token = ${leaseToken} and lease_expires_at > now()
      returning id
    `)).rows;
    if (finalized.length !== 1) {
      await diagnoseFenceMiss(db, orgId, requestId);
    }
    return result;
  });
}

/**
 * Execute the approved correction: one fenced attempt that re-proves v0
 * before any metric write. A succeeded request replays its recorded result
 * byte-for-byte; any source, hash, rate, row-count, or affected-row drift
 * rolls every metric write back and records a guarded failed outcome with
 * the real remedy. Never blindly resumes a partially computed payload:
 * every attempt recomputes from unchanged sources inside one transaction.
 */
export async function executeNormalizationRequest(args: {
  orgId: string;
  requestId: string;
  leaseToken: string;
  leaseTtlMinutes?: number;
}): Promise<NormalizationExecutionResult> {
  const orgId = requireUuid(args.orgId, "org_id");
  const requestId = requireUuid(args.requestId, "request_id");
  const leaseToken = requireUuid(args.leaseToken, "lease_token");
  const ttlMinutes = args.leaseTtlMinutes ?? DEFAULT_LEASE_MINUTES;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw refusal(
      "saas_normalization_lease_ttl_invalid",
      "The lease duration must be between 1 and 1440 minutes.",
      "Request a lease of 1 to 1440 minutes when executing in Company Setup → SaaS Metrics.",
      { field: "leaseTtlMinutes" },
    );
  }
  const peek = await withOrgTransaction(orgId, async () => readRequest(db, orgId, requestId));
  if (!peek) throw missingRequest(requestId);
  if (peek.status === "succeeded" && peek.result) return peek.result;
  try {
    return await runCorrectionAttempt(orgId, requestId, leaseToken, ttlMinutes);
  } catch (error) {
    // Fence and state refusals fire before any metric work starts, so there
    // is no failed outcome to record; drift, source, rate, and write
    // refusals after the live claim record one under the live lease.
    if (
      error instanceof UsageBillingError
      && [
        "saas_normalization_request_missing",
        "saas_normalization_execute_state",
        "saas_normalization_execute_unapproved",
        "saas_normalization_lease_mismatch",
        "saas_normalization_lease_state",
        "saas_normalization_lease_live",
        "feature_off",
      ].includes(error.code)
    ) {
      throw error;
    }
    const month = peek.month.slice(0, 10);
    const { failure, remedy, error: original } = toFailure(error, month);
    await recordExecutionFailure({ orgId, requestId, leaseToken, failure, remedy, original });
  }
}
