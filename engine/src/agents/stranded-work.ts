/** Durable queue failures remain actionable until the owning worker resolves them.
 * This detector creates review work; it never retries financial effects or sends email. */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { AgentFinding } from "./types.ts";

type StrandedWork = {
  id: string; surface: string; subjectId: string | null; kind: string;
  status: string; attempts: number; terminal: boolean; lastActivity: string;
};

export async function strandedWorkFindings(orgId: string, staleOnOrBefore: string): Promise<AgentFinding[]> {
  const rows = await db.execute<StrandedWork>(sql`
    select id, 'posting_effects' as surface, document_id as "subjectId", kind,
           status, attempt_count as attempts, status = 'terminal_failed' as terminal,
           updated_at::text as "lastActivity"
      from posting_effects
     where org_id = ${orgId} and (
       status = 'terminal_failed' or
       (status in ('pending','running','failed') and updated_at < ${staleOnOrBefore}::date
         and next_attempt_at <= now()))
    union all
    select id, 'scheduler_outbox', subject_id, kind, status, attempt_count,
           terminal_failed_at is not null, updated_at::text
      from scheduler_outbox
     where org_id = ${orgId} and status in ('pending','running','failed') and (
       terminal_failed_at is not null or
       (updated_at < ${staleOnOrBefore}::date and next_attempt_at <= now()))
    union all
    select id, 'report_runs', definition_id, 'report_generation', status, attempt_count,
           terminal_failed_at is not null, updated_at::text
      from report_runs
     where org_id = ${orgId} and status in ('queued','running','failed') and (
       terminal_failed_at is not null or
       (updated_at < ${staleOnOrBefore}::date and coalesce(next_attempt_at, created_at) <= now()))
    union all
    select id, 'report_delivery_outbox', run_id, 'report_email', status, attempt_count,
           terminal_failed_at is not null, updated_at::text
      from report_delivery_outbox
     where org_id = ${orgId} and status in ('pending','enqueued','sending','failed') and (
       terminal_failed_at is not null or
       (updated_at < ${staleOnOrBefore}::date and next_attempt_at <= now()))
  `);
  return rows.rows.map((row) => ({
    agentKey: "accounting",
    findingType: "stranded_background_work",
    fingerprint: `stranded-work:${row.surface}:${row.id}`,
    severity: row.terminal ? "critical" : "warning",
    confidence: "1.0000",
    materiality: "0.0000",
    subjectType: row.surface,
    subjectId: row.id,
    summary: {
      surface: row.surface, kind: row.kind, status: row.status,
      attempts: row.attempts, lastActivity: row.lastActivity,
      href: row.surface === "posting_effects" && row.subjectId
        ? `/close?txn=${encodeURIComponent(row.subjectId)}` : "/close",
      remedy: row.surface === "posting_effects"
        ? "Review the document's posting-effects failure and use the controlled retry action with a reason."
        : "Review the recorded failure and repair the owning worker or delivery configuration. Report generation can be requested again from its report; inspect delivery evidence before sending another email.",
    },
    evidence: [{
      kind: "durable_work", sourceType: row.surface, sourceId: row.id,
      data: { subjectId: row.subjectId, status: row.status, attempts: row.attempts, terminal: row.terminal, lastActivity: row.lastActivity },
    }],
  }));
}
