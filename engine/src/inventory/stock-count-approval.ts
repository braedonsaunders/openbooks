import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import type { FlowSubmissionPolicy } from "../platform/flow-submission-policy.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { InventoryError } from "./contracts.ts";

type CountRouting = (input: {
  orgId: string;
  actorId: string;
  countId: string;
  cancel?: boolean;
}) => Promise<FlowSubmissionPolicy | void>;
let routing: CountRouting | null = null;
/** Composition supplies the sole Flow engine; an uninstalled seam refuses. */
export function registerStockCountRouting(handler: CountRouting): void {
  routing = handler;
}
export async function routeStockCount(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<FlowSubmissionPolicy> {
  if (!actorId) throw new InventoryError("A named inventory operator must submit this count.");
  if (!routing)
    throw new InventoryError(
      "Stock count Flow routing is unavailable; retry after the application starts.",
    );
  const policy = await routing({ orgId, actorId, countId });
  if (!policy) throw new InventoryError("The stock count received no submission verdict.");
  return policy;
}
export async function cancelStockCountRouting(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<void> {
  if (!actorId || !routing)
    throw new InventoryError(
      "A named operator and native Flow routing are required to withdraw count review.",
    );
  await routing({ orgId, actorId, countId, cancel: true });
}
/** Called only after composition verifies completed native gate decisions. */
export async function releaseStockCountReview(input: {
  orgId: string;
  countId: string;
  actorId: string;
  outcome: "approved" | "rejected";
}): Promise<void> {
  await withOrgTransaction(input.orgId, async () => {
    const row = (
      await db.execute<{
        subsidiary_id: string;
      }>(
        sql`select subsidiary_id from stock_counts
      where org_id=${input.orgId} and id=${input.countId} and status='review' for update`,
        "objects",
      )
    )[0];
    if (!row) throw new InventoryError("The count left review; reopen its current version.");
    await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      row.subsidiary_id,
      "items.post",
    );
    const result = await db.execute(
      sql`update stock_counts set
      review_released=${input.outcome === "approved"},
      status=${input.outcome === "approved" ? "review" : "counting"},
      updated_at=now(),updated_by=${input.actorId}
      where org_id=${input.orgId} and id=${input.countId} and status='review' returning id`,
      "objects",
    );
    if (result.length !== 1)
      throw new InventoryError("The stock count changed during its Flow decision.");
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes)
      values(${input.orgId},'stock_counts',${input.countId},${input.outcome === "approved" ? "approve" : "reject"},${input.actorId},
        ${JSON.stringify({ review: input.outcome, source: "flow" })}::jsonb)`);
  });
}
