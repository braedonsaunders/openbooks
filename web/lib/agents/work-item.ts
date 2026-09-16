import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import type { ContinuousCloseAgentKey } from "@openbooks/engine/src/continuous-close-config.ts";
import type { ContinuousCloseWorkItem } from "../../app/(app)/continuous-close/WorkItemDrawer";

type WorkItemDetailRow = {
  id: string;
  agent_key: ContinuousCloseAgentKey;
  finding_type: string;
  severity: ContinuousCloseWorkItem["severity"];
  status: ContinuousCloseWorkItem["status"];
  confidence: string;
  materiality: string;
  summary: Record<string, unknown>;
  first_detected_at: string | Date;
  last_detected_at: string | Date;
  dismissal_reason: string | null;
  rating: "helpful" | "not_helpful" | null;
};

type EvidenceRow = {
  id: string;
  kind: string;
  source_type: string;
  source_id: string;
  data: Record<string, unknown> | null;
};

/**
 * One finding with its evidence packet and the viewer's feedback, scoped to
 * the org and to agent packs the caller may read. Shared by the
 * /continuous-close screen, the /agents workbench, and the item JSON
 * endpoint — a second SQL path to the same data is how the screens and the
 * assistant learn to disagree.
 */
export async function loadWorkItemDetail(
  orgId: string,
  userId: string,
  itemId: string,
  readable: readonly ContinuousCloseAgentKey[],
): Promise<ContinuousCloseWorkItem | null> {
  if (readable.length === 0) return null;
  const readableSql = sql.raw(`(${readable.map((key) => `'${key}'`).join(",")})`);
  const detail = await db.execute<WorkItemDetailRow>(sql`
    select w.*, f.rating
      from ai_work_items w
      left join ai_work_item_feedback f on f.work_item_id = w.id and f.org_id = w.org_id and f.user_id = ${userId}
     where w.id = ${itemId} and w.org_id = ${orgId} and w.agent_key in ${readableSql}
  `);
  const row = detail.rows[0];
  if (!row) return null;
  const evidence = await db.execute<EvidenceRow>(sql`
    select id, kind, source_type, source_id, data
      from ai_work_item_evidence where work_item_id = ${itemId} and org_id = ${orgId}
     order by created_at, id
  `);
  return {
    id: row.id,
    agentKey: row.agent_key,
    findingType: row.finding_type,
    severity: row.severity,
    status: row.status,
    confidence: row.confidence,
    materiality: row.materiality,
    summary: row.summary ?? {},
    firstDetectedAt: new Date(row.first_detected_at).toISOString(),
    lastDetectedAt: new Date(row.last_detected_at).toISOString(),
    dismissalReason: row.dismissal_reason,
    feedback: row.rating ?? null,
    evidence: evidence.rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      sourceType: e.source_type,
      sourceId: e.source_id,
      data: e.data ?? {},
    })),
  };
}
