/**
 * Flows approval authority for operator employment mapping sets.
 *
 * Free-text approvedBy/approvedAt/rationale on a mapping carry no
 * authority: a mapping is applicable only under a decided Flows gate over
 * the digest of the exact mapping set. This module is the only place that
 * reads that authority from the database:
 *
 * - resolveMappingApprovalSnapshots re-resolves every named gate from
 *   flow_gates plus its migration-mapping approval subject row, inside the
 *   caller's own org transaction, and overwrites whatever snapshot (if
 *   any) the input rows claim — caller JSON can never forge authority.
 *   A gate (or its subject row) no read can observe, or a gate deciding
 *   some other subject kind, throws: that is confusion, not a routine
 *   refusal. Status, decider, and digest attach truthfully and the pure
 *   classifier turns them into per-candidate verdicts in the report.
 * - requestMigrationMappingApproval pins a mapping set's digest into a new
 *   approval subject row (idempotent per org and digest) and submits it
 *   through the Flows engine — the one approvals system, never a second
 *   one — mirroring the HRM change-request submit path (failed dispatch
 *   cancels its stray gates; no enabled flow is a named refusal).
 *
 * Both entry points run inside the caller's withOrgTransaction with bypass
 * off; every statement carries an explicit org predicate.
 */

import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND } from "@openbooks/schema/src/hrm.ts";
import {
  hashOperatorMappingSet,
  type MappingSetEntry,
  type SourcePersonRow,
} from "./migration-preflight.ts";

/** A mapping-approval authority failure that must reach the operator. */
export class MappingApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingApprovalError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPROVAL_REMEDY =
  "request Flows approval for the exact mapping set, then re-run with the " +
  "decided approval gate id and the applying actor (--applied-by)";

function requireUuid(value: string, what: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new MappingApprovalError(
      `${what} ${JSON.stringify(value)} is not a valid UUID; refusing to resolve mapping approval ` +
        `without an explicit identity — ${APPROVAL_REMEDY}`,
    );
  }
  return value;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type GateResolution = {
  gate_id: string;
  gate_status: string;
  decided_by: string | null;
  subject_kind: string;
  subject_digest: string | null;
};

/**
 * Re-resolve every named approval gate from the database and attach the
 * truthful snapshot to its rows. Rows naming no gate get an explicit null
 * snapshot (any input-claimed snapshot is stripped: authority is
 * re-resolved, never accepted). Returns new row objects; never mutates
 * input. Throws MappingApprovalError when a named gate, its subject row,
 * or the gate's subject kind is not what a mapping approval must be —
 * a reference no read can observe, or an approval for something else, is
 * a failure, never a silent skip.
 */
export async function resolveMappingApprovalSnapshots(
  orgId: string,
  rows: readonly SourcePersonRow[],
): Promise<SourcePersonRow[]> {
  requireUuid(orgId, "org");
  const gateIds = new Map<string, string>();
  for (const row of rows) {
    const gateId = row.resolution?.approvalGateId ?? "";
    if (!isNonBlank(gateId)) continue;
    requireUuid(gateId, "operator mapping approval gate");
    // UUID text is case-insensitive: fold the lookup key so one gate named
    // in two cases still resolves to one snapshot (postgres compares
    // uuid values, never text).
    gateIds.set(gateId.toLowerCase(), gateId);
  }
  const snapshots = new Map<string, GateResolution>();
  for (const [lookupKey, gateId] of gateIds) {
    const found = (await db.execute<GateResolution>(sql`
      select g.id::text as gate_id, g.status as gate_status,
             g.decided_by::text as decided_by,
             g.subject_kind as subject_kind,
             a.mapping_digest as subject_digest
        from flow_gates g
        left join hrm_employment_migration_approvals a
          on a.org_id = g.org_id and a.id = g.subject_id
       where g.org_id = ${orgId} and g.id = ${gateId}`)) as unknown as {
      rows: GateResolution[];
    };
    const gate = found.rows[0] ?? null;
    if (gate === null) {
      // A write that matches zero rows is a failure, not a success: under
      // RLS an unscoped gate id silently matches nothing and reports
      // success — the most dangerous shape here.
      throw new MappingApprovalError(
        `operator mapping names approval gate ${gateId} which no read can observe in this org; ` +
          `refusing to migrate under an unobservable approval — ${APPROVAL_REMEDY}`,
      );
    }
    if (gate.subject_kind !== HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND) {
      throw new MappingApprovalError(
        `approval gate ${gateId} decides subject kind ${gate.subject_kind}, not a migration mapping ` +
          `set; refusing to let an approval for something else authorize these mappings — ${APPROVAL_REMEDY}`,
      );
    }
    if (gate.subject_digest === null) {
      throw new MappingApprovalError(
        `approval gate ${gateId} names a migration approval subject no read can observe; ` +
          `refusing to migrate onto a missing approval subject — re-request approval for this mapping set`,
      );
    }
    snapshots.set(lookupKey, gate);
  }
  return rows.map((row) => {
    if (row.resolution === null) return row;
    const gateId = row.resolution.approvalGateId ?? "";
    if (!isNonBlank(gateId)) {
      return { ...row, resolution: { ...row.resolution, approval: null } };
    }
    const gate = snapshots.get(gateId.toLowerCase());
    if (!gate) {
      return { ...row, resolution: { ...row.resolution, approval: null } };
    }
    return {
      ...row,
      resolution: {
        ...row.resolution,
        approval: {
          gateId: gate.gate_id,
          status: gate.gate_status,
          decidedBy: gate.decided_by,
          subjectKind: gate.subject_kind,
          subjectDigest: gate.subject_digest ?? "",
        },
      },
    };
  });
}

export interface RequestedMappingApproval {
  /** The approval subject row id (stable per org and digest). */
  readonly approvalId: string;
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
    const existing = (await db.execute<{ id: string; status: string }>(sql`
      select id::text as id, status
        from hrm_employment_migration_approvals
       where org_id = ${orgId} and mapping_digest = ${digest}`)) as unknown as {
      rows: Array<{ id: string; status: string }>;
    };
    const prior = existing.rows[0] ?? null;
    if (prior !== null) return { approvalId: prior.id, digest, created: false, runIds: [], gateIds: [] };

    const inserted = (await db.execute<{ id: string }>(sql`
      insert into hrm_employment_migration_approvals
        (org_id, mapping_digest, status, requested_by, created_by, updated_by)
      values (${orgId}, ${digest}, 'draft', ${requestedBy}, ${requestedBy}, ${requestedBy})
      returning id::text as id`)) as unknown as { rows: Array<{ id: string }> };
    const approvalId = inserted.rows[0]?.id ?? null;
    if (approvalId === null) {
      // A write that matches zero rows is a failure, never success.
      throw new MappingApprovalError(
        "recording the mapping approval subject matched zero rows; refusing to report success " +
          "for an unobservable write — check the org RLS scope and re-request",
      );
    }

    // Lazy: engine/src/flows/run.ts → registry → this service's adapter.
    const { runRecordFlows } = await import("../flows/run.ts");
    const flowResult = await runRecordFlows(
      { kind: "on_submit", source: "api" },
      HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND,
      approvalId,
      { orgId, userId: requestedBy },
    );
    const gatedRuns = flowResult.runs.filter((run) => run.gatesCreated > 0);
    if (flowResult.failed || gatedRuns.length === 0) {
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
        throw new MappingApprovalError(
          "approval routing failed for this mapping set — fix the approval flow, then request again",
        );
      }
      throw new MappingApprovalError(
        "no enabled approval flow produced an approval gate for employment migration mappings — " +
          "configure a flow for employment migration mappings before requesting",
      );
    }
    const flipped = (await db.execute<{ id: string }>(sql`
      update hrm_employment_migration_approvals
         set status = 'pending_approval', updated_by = ${requestedBy}, updated_at = now()
       where id = ${approvalId} and org_id = ${orgId} and status = 'draft'
      returning id::text as id`)) as unknown as { rows: Array<{ id: string }> };
    if (flipped.rows.length !== 1) {
      throw new MappingApprovalError(
        `mapping approval ${approvalId} changed while submission was being recorded; ` +
          "refusing to report success for an unobservable write",
      );
    }
    const runIds = gatedRuns.map((run) => run.runId);
    const gates = (await db.execute<{ id: string }>(sql`
      select g.id::text as id
        from flow_gates g
       where g.org_id = ${orgId}
         and g.run_id in (
           select jsonb_array_elements_text(${JSON.stringify(runIds)}::jsonb)::uuid
         )
         and g.status in ('pending', 'escalated')
       order by g.created_at`)) as unknown as { rows: Array<{ id: string }> };
    return {
      approvalId,
      digest,
      created: true,
      runIds,
      gateIds: gates.rows.map((gate) => gate.id),
    };
  });
}
