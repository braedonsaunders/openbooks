import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { requireHrmSelfRead } from "../authorization.ts";
import { AiRailsError } from "./errors.ts";
import { AI_CAPABILITIES, assertAutonomyAtOrBelowMax, requireCapability } from "./registry.ts";

/**
 * HRM AI rails (HR-21) governance: the capability mirror sync, the
 * decision-log writer every tool MUST call, autonomy edits (down only),
 * and the review-cadence nudge source.
 *
 * Every public entry runs inside one org transaction: one user action is
 * one transaction, and a write matching zero rows fails, never succeeds.
 */

export const AI_FEATURE_KEYS = [
  "hrmAiAssist",
  "hrmExplainPay",
  "hrmPayrollAnomalies",
  "hrmTimeAnomalies",
  "hrmDrafting",
  "hrmNlReports",
  "aiGovernanceLedger",
] as const;

function requireIds(orgId: unknown, actorId: unknown): { orgId: string; actorId: string } {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new AiRailsError("ai_invalid_input", "orgId must be a non-empty string");
  }
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new AiRailsError("ai_invalid_input", "actorId must be a non-empty string");
  }
  return { orgId, actorId };
}

/** Engine-side feature gate: the ledger refuses while hrm itself is off. */
export async function assertHrmOn(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new AiRailsError(
      "ai_hrm_off",
      "AI rails are unavailable while the hrm feature is off — enable it under Company Settings → Features; existing data is preserved",
    );
  }
}

/** Stable hex digest of a prompt/output — the log keeps hashes, never text. */
export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type DecisionOutcome = "shown" | "accepted" | "edited" | "rejected" | "expired";

export interface LogDecisionInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly capabilityKey: string;
  readonly subjectKind: string;
  readonly subjectId?: string | null;
  /** Raw prompt/input — hashed before storage, never stored. */
  readonly input: string;
  /** Raw output — hashed before storage, never stored. */
  readonly output: string;
  /** One line, no PII: what was produced and from which records. */
  readonly outputSummary: string;
  /** The record ids the output cited. */
  readonly sources: readonly { kind: string; id: string }[];
  readonly outcome: DecisionOutcome;
  readonly humanReviewer?: string | null;
  readonly model: string;
}

/**
 * Append one decision row. Every AI tool calls this before returning —
 * a tool that cannot log refuses instead of answering silently.
 */
export async function logDecision(exec: SqlExecutor, input: LogDecisionInput): Promise<string> {
  const { orgId, actorId } = requireIds(input.orgId, input.actorId);
  requireCapability(input.capabilityKey);
  if (input.outputSummary.trim().length === 0) {
    throw new AiRailsError("ai_invalid_input", "outputSummary must be a one-line PII-free summary");
  }
  const rows = (await exec.execute<{ id: string }>(sql`
    insert into ai_decisions (
      org_id, capability_key, actor_user_id, subject_kind, subject_id,
      input_digest, output_digest, output_summary, sources, outcome,
      human_reviewer, model
    ) values (
      ${orgId}::uuid, ${input.capabilityKey}, ${actorId}::uuid,
      ${input.subjectKind}, ${input.subjectId ?? null}::uuid,
      ${digest(input.input)}, ${digest(input.output)}, ${input.outputSummary},
      ${JSON.stringify(input.sources.map((s) => ({ kind: s.kind, id: s.id })))}::jsonb,
      ${input.outcome}, ${input.humanReviewer ?? null}::uuid, ${input.model}
  ) returning id::text as id`)).rows;
  // A write matching zero rows is a failure, not a success.
  if (!rows[0]) {
    throw new AiRailsError(
      "ai_decision_not_logged",
      "the AI decision was not logged — nothing was produced; reload and retry",
    );
  }
  return rows[0].id;
}

export type CapabilityRow = {
  id: string;
  key: string;
  name: string;
  purpose: string;
  dataScope: unknown;
  autonomy: string;
  reviewerRole: string | null;
  noticeRequired: boolean;
  enabled: boolean;
  lastReviewedAt: string | null;
  reviewedBy: string | null;
}

/**
 * Seed the org mirror from the code registry when a feature turns on.
 * Existing rows are never overwritten — the org's lowered autonomy and
 * review stamps survive re-syncs. Returns the rows seeded.
 */
export async function syncCapabilities(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<string[]> {
  requireIds(orgId, actorId);
  await assertHrmOn(exec, orgId);
  const seeded: string[] = [];
  for (const def of AI_CAPABILITIES.values()) {
    const rows = (await exec.execute<{ id: string }>(sql`
      insert into ai_capabilities (
        org_id, key, name, purpose, data_scope, autonomy,
        reviewer_role, notice_required, enabled
      ) values (
        ${orgId}::uuid, ${def.key}, ${def.name}, ${def.purpose},
        ${JSON.stringify(def.dataScope)}::jsonb, ${def.maxAutonomy},
        ${def.reviewerRole}, ${def.noticeRequired}, true
      )
      on conflict do nothing
      returning id::text as id`)).rows;
    // The conflict target is the rescan-style (org, key) unique: a conflict
    // means this org already owns the row, which is expected and benign —
    // sync must never overwrite the org's lowered autonomy.
    if (rows[0]) seeded.push(def.key);
  }
  return seeded;
}

/** List the org's capability rows (ledger read). */
export async function listCapabilities(exec: SqlExecutor, orgId: string): Promise<CapabilityRow[]> {
  const rows = (await exec.execute<CapabilityRow>(sql`
    select id::text as id, key, name, purpose, data_scope as "dataScope",
           autonomy, reviewer_role as "reviewerRole",
           notice_required as "noticeRequired", enabled,
           last_reviewed_at::text as "lastReviewedAt",
           reviewed_by::text as "reviewedBy"
      from ai_capabilities
     where org_id = ${orgId}::uuid
     order by key`)).rows;
  return rows;
}

/**
 * Edit autonomy DOWN only, or record a review. Raises above the code
 * maximum refuse by name. Zero matched rows fail (unscoped writes under
 * RLS silently match nothing and must never report success).
 */
export async function updateCapability(
  exec: SqlExecutor,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly key: string;
    readonly autonomy?: string;
    readonly reviewerRole?: string | null;
    readonly enabled?: boolean;
    readonly markReviewed?: boolean;
  },
): Promise<CapabilityRow> {
  const { orgId, actorId } = requireIds(input.orgId, input.actorId);
  const def = requireCapability(input.key);
  if (!(await actorHasPermission(exec, orgId, actorId, "admin.setup.manage"))) {
    throw new AiRailsError(
      "ai_forbidden",
      `AI capability "${input.key}" needs the setup administrator — ask an administrator to change it on /admin/ai`,
    );
  }
  if (input.autonomy !== undefined) assertAutonomyAtOrBelowMax(input.key, input.autonomy);
  const reviewedAt = input.markReviewed ? sql`now()` : sql`last_reviewed_at`;
  const reviewedBy = input.markReviewed ? sql`${actorId}::uuid` : sql`reviewed_by`;
  const rows = (await exec.execute<CapabilityRow>(sql`
    update ai_capabilities
       set autonomy = coalesce(${input.autonomy ?? null}, autonomy),
           reviewer_role = coalesce(${input.reviewerRole ?? null}, reviewer_role),
           enabled = coalesce(${input.enabled ?? null}, enabled),
           last_reviewed_at = ${reviewedAt},
           reviewed_by = ${reviewedBy},
           updated_by = ${actorId}::uuid,
           updated_at = now()
     where org_id = ${orgId}::uuid and key = ${input.key}
    returning id::text as id, key, name, purpose, data_scope as "dataScope",
           autonomy, reviewer_role as "reviewerRole",
           notice_required as "noticeRequired", enabled,
           last_reviewed_at::text as "lastReviewedAt",
           reviewed_by::text as "reviewedBy"`)).rows;
  const row = rows[0];
  if (!row) {
    throw new AiRailsError(
      "ai_capability_missing",
      `AI capability "${input.key}" is not registered for this organization — sync it from the code registry on /admin/ai first`,
    );
  }
  await logDecision(exec, {
    orgId,
    actorId,
    capabilityKey: def.key,
    subjectKind: "ai_capability",
    subjectId: row.id,
    input: `updateCapability ${def.key}`,
    output: `autonomy=${row.autonomy} enabled=${row.enabled}`,
    outputSummary: `capability ${def.key} updated (autonomy ${row.autonomy})`,
    sources: [{ kind: "ai_capability", id: row.id }],
    outcome: "accepted",
    humanReviewer: actorId,
    model: "governance-service",
  });
  return row;
}

/** Capabilities whose last review is older than the org's declared months. */
export async function overdueReviews(
  exec: SqlExecutor,
  orgId: string,
  olderThanMonths: number,
): Promise<CapabilityRow[]> {
  const rows = (await exec.execute<CapabilityRow>(sql`
    select id::text as id, key, name, purpose, data_scope as "dataScope",
           autonomy, reviewer_role as "reviewerRole",
           notice_required as "noticeRequired", enabled,
           last_reviewed_at::text as "lastReviewedAt",
           reviewed_by::text as "reviewedBy"
      from ai_capabilities
     where org_id = ${orgId}::uuid
       and (last_reviewed_at is null
            or last_reviewed_at < now() - (${olderThanMonths}::int * interval '1 month'))
     order by key`)).rows;
  return rows;
}

/** Public boundary: sync the registry mirror. One transaction. */
export async function syncCapabilitiesForOrg(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<string[]> {
  const { orgId, actorId } = requireIds(query.orgId, query.actorId);
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      await requireHrmSelfRead(tx, orgId, actorId).catch(async () => {
        if (!(await actorHasPermission(tx, orgId, actorId, "admin.setup.manage"))) {
          throw new AiRailsError(
            "ai_forbidden",
            "syncing the AI capability registry needs self-service access or the setup administrator — ask an administrator on /admin/ai",
          );
        }
      });
      return syncCapabilities(tx, orgId, actorId);
    }),
  );
}
