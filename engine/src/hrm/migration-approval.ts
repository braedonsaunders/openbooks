/** Mapping sets derive authority solely from their canonical tenant Flow submission. */

import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND } from "@openbooks/schema/src/hrm.ts";
import {
  hashOperatorMappingSet,
  type MappingSetEntry,
  type SourcePersonRow,
} from "./migration-preflight.ts";
import { isUuid } from "../platform/uuid.ts";
import { routeNativeApproval, lockApprovalSubject } from "../platform/approval-routing.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";

/** A mapping-approval authority failure that must reach the operator. */
export class MappingApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingApprovalError";
  }
}

const APPROVAL_REMEDY =
  "Submit the exact mapping set through Flows and supply its native submission receipt and applying actor.";

function requireUuid(value: string, what: string): string {
  if (!isUuid(value)) {
    throw new MappingApprovalError(
      `${what} ${JSON.stringify(value)} is not a valid UUID; refusing to resolve mapping approval ` +
        `without an explicit identity — ${APPROVAL_REMEDY}`,
    );
  }
  return value;
}

/** Resolve every authority claim from the canonical immutable Flow submission ledger. */
export async function resolveMappingApprovalSnapshots(
  orgId: string,
  rows: readonly SourcePersonRow[],
): Promise<SourcePersonRow[]> {
  requireUuid(orgId, "org");
  const proofs = new Map<
    string,
    {
      submissionId: string;
      status: string;
      subjectKind: string;
      subjectDigest: string;
    }
  >();
  for (const row of rows) {
    const id = row.resolution?.approvalSubmissionId;
    if (!id || proofs.has(id.toLowerCase())) continue;
    requireUuid(id, "mapping Flow submission");
    const proof = (
      await db.execute<{
        submissionId: string;
        status: string;
        subjectKind: string;
        subjectDigest: string;
      }>(
        sql`
   select s.id as "submissionId",s.subject_kind as "subjectKind",a.mapping_digest as "subjectDigest",
    case when a.status='approved' and s.context->>'mappingDigest'=a.mapping_digest
      and (public.flow_ungated_submission_authorized(s.org_id,s.subject_kind,s.subject_id,s.actor_id) or public.flow_submission_approved(s.org_id,s.subject_kind,s.subject_id,s.id))
      and not exists(select 1 from flow_submissions newer where newer.org_id=s.org_id and newer.subject_kind=s.subject_kind
        and newer.subject_id=s.subject_id and (newer.created_at,newer.id)>(s.created_at,s.id)) then 'approved' else a.status||'_unreleased' end as status
   from flow_submissions s join hrm_employment_migration_approvals a on a.org_id=s.org_id and a.id=s.subject_id
   where s.org_id=${orgId} and s.id=${id} and s.subject_kind=${HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND}`,
        "objects",
      )
    )[0];
    if (!proof)
      throw new MappingApprovalError(
        "The named mapping submission is unavailable in this organization. Submit the exact mapping set through Flows.",
      );
    proofs.set(id.toLowerCase(), proof);
  }
  return rows.map((row) =>
    row.resolution
      ? {
          ...row,
          resolution: {
            ...row.resolution,
            approval: proofs.get(row.resolution.approvalSubmissionId?.toLowerCase() ?? "") ?? null,
          },
        }
      : row,
  );
}

export interface RequestedMappingApproval {
  /** The approval subject row id (stable per org and digest). */
  readonly approvalId: string;
  readonly submissionId: string;
  readonly status: "pending_approval" | "approved";
  /** The pinned mapping-set digest the approver saw. */
  readonly digest: string;
  /** False when an earlier request already pinned this digest. */
  readonly created: boolean;
  /** Flow run ids deciding this approval (empty when already decided). */
  readonly runIds: readonly string[];
  /** Pending gate ids awaiting a decider (empty when already decided). */
  readonly gateIds: readonly string[];
}

/**
 * Pin a mapping set's digest and submit it for Flows approval. Idempotent
 * per (org, digest): re-requesting the same set returns the existing
 * subject row instead of a duplicate. Runs inside its own org transaction.
 */
export async function requestMigrationMappingApproval(
  orgId: string,
  entries: readonly MappingSetEntry[],
  requestedBy: string,
): Promise<RequestedMappingApproval> {
  requireUuid(orgId, "org");
  requireUuid(requestedBy, "approval requester");
  if (entries.length === 0) {
    throw new MappingApprovalError(
      "refusing to request approval for an empty mapping set: an approval must cover exact mapping " +
        "facts — supply at least one operator mapping",
    );
  }
  const digest = hashOperatorMappingSet(entries);
  return withOrgTransaction(orgId, async () => {
    const scope = await lockActorCommandAuthority(
      db,
      orgId,
      requestedBy,
      null,
      "hrm.employment.manage",
    );
    if (scope !== null)
      throw new MappingApprovalError(
        "Organization-wide employment authority is required to submit a mapping set.",
      );
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"mapping-submission:" + orgId + ":" + digest},0))`,
    );
    let prior = (
      await db.execute<{
        id: string;
        status: string;
        submissionId: string | null;
      }>(
        sql`select a.id,a.status,
      (select s.id from flow_submissions s where s.org_id=a.org_id and s.subject_kind=${HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND} and s.subject_id=a.id order by created_at desc,id desc limit 1) as "submissionId"
      from hrm_employment_migration_approvals a where a.org_id=${orgId} and a.mapping_digest=${digest}`,
        "objects",
      )
    )[0];
    const approvalId =
      prior?.id ??
      (
        await db.execute<{
          id: string;
        }>(
          sql`insert into hrm_employment_migration_approvals(org_id,mapping_digest,status,requested_by,created_by,updated_by)
      values(${orgId},${digest},'draft',${requestedBy},${requestedBy},${requestedBy}) returning id`,
          "objects",
        )
      )[0]?.id;
    if (!approvalId) throw new MappingApprovalError("The mapping submission was not stored.");
    await lockApprovalSubject(orgId, HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND, approvalId);
    if (prior) {
      const current = (
        await db.execute<{ status: string }>(
          sql`select status from hrm_employment_migration_approvals where org_id=${orgId} and id=${approvalId} for update`,
          "objects",
        )
      )[0];
      if (!current)
        throw new MappingApprovalError("The mapping submission is no longer available.");
      prior = { ...prior, status: current.status };
    }
    if (prior?.submissionId && ["pending_approval", "approved"].includes(prior.status)) {
      const gates = await db.execute<{ id: string; run_id: string }>(
        sql`select id,run_id from flow_gates where org_id=${orgId} and subject_kind=${HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND} and subject_id=${approvalId} and status in('pending','escalated')`,
        "objects",
      );
      if (prior.status === "approved" || gates.length)
        return {
          approvalId,
          digest,
          submissionId: prior.submissionId,
          status: prior.status as "approved" | "pending_approval",
          created: false,
          runIds: [...new Set(gates.map((g) => g.run_id))],
          gateIds: gates.map((g) => g.id),
        };
    }
    if (prior)
      await db.execute(
        sql`update hrm_employment_migration_approvals set status='draft',updated_by=${requestedBy},updated_at=now() where org_id=${orgId} and id=${approvalId}`,
      );
    const routing = await routeNativeApproval({
      orgId,
      actorId: requestedBy,
      subjectKind: HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND,
      subjectId: approvalId,
    });
    const status = routing.policy.kind === "gated" ? "pending_approval" : "approved";
    const saved = await db.execute(
      sql`update hrm_employment_migration_approvals set status=${status},updated_by=${requestedBy},updated_at=now() where org_id=${orgId} and id=${approvalId} and status='draft' returning id`,
      "objects",
    );
    if (saved.length !== 1)
      throw new MappingApprovalError(
        "The mapping submission changed before its outcome was recorded.",
      );
    await db.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'hrm_employment_migration_approvals',${approvalId},'submit',${JSON.stringify({ digest, submissionId: routing.submissionId, policy: routing.policy, status })}::jsonb,${requestedBy})`,
    );
    const gates = await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${orgId} and subject_kind=${HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND} and subject_id=${approvalId} and status in('pending','escalated')`,
      "objects",
    );
    return {
      approvalId,
      digest,
      submissionId: routing.submissionId,
      status,
      created: true,
      runIds: routing.policy.runIds,
      gateIds: gates.map((g) => g.id),
    };
  });
}
