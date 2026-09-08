import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { isUuid } from "./list-params";
import type { PromotionState } from "./sandbox-promotion";

export interface ChangeSetItem extends Record<string, unknown> {
  id: string;
  tableName: string;
  targetId: string;
  op: "insert" | "update" | "delete";
  payload: Record<string, unknown> | null;
  expectedBefore: Record<string, unknown> | null;
  baseCaptured: boolean;
}
export interface ChangeSetDetail extends PromotionState {
  id: string;
  name: string;
  sandboxName: string | null;
  createdAt: string;
  reviewedAt: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  createdName: string | null;
  reviewedName: string | null;
  approvedName: string | null;
  appliedName: string | null;
  items: ChangeSetItem[];
}

/** Caller authenticates the manager; every read is pinned to that production org. */
export async function loadChangeSetDetail(orgId: string, id: string): Promise<ChangeSetDetail | null> {
  if (!isUuid(id)) return null;
  const result = await db.execute<Omit<ChangeSetDetail, "items" | "capturedCount" | "baseComplete">>(sql`
    select c.id,c.name,c.status,c.capture_complete as "captureComplete",c.item_count as "itemCount",
      c.created_by as "createdBy",c.reviewed_by as "reviewedBy",c.approved_by as "approvedBy",
      c.created_at::text as "createdAt",c.reviewed_at::text as "reviewedAt",c.approved_at::text as "approvedAt",c.applied_at::text as "appliedAt",
      creator.name as "createdName",reviewer.name as "reviewedName",approver.name as "approvedName",applier.name as "appliedName",s.name as "sandboxName"
    from change_sets c
    left join sandboxes s on s.org_id=c.sandbox_org_id and s.production_org_id=c.org_id
    left join users creator on creator.id=c.created_by and creator.org_id=c.org_id
    left join users reviewer on reviewer.id=c.reviewed_by and reviewer.org_id=c.org_id
    left join users approver on approver.id=c.approved_by and approver.org_id=c.org_id
    left join users applier on applier.id=c.applied_by and applier.org_id=c.org_id
    where c.id=${id} and c.org_id=${orgId}`);
  const header = result.rows[0];
  if (!header) return null;
  const items = (await db.execute<ChangeSetItem>(sql`
    select id,table_name as "tableName",target_id as "targetId",op,payload,
      expected_before as "expectedBefore",base_captured as "baseCaptured"
    from change_set_items where change_set_id=${id} and org_id=${orgId} order by created_at,id`)).rows;
  return { ...header, items, capturedCount: items.length, baseComplete: items.every(item => item.baseCaptured) };
}
