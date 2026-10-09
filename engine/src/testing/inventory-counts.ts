import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchUser } from "./fixtures.ts";
import { requiresSecondCount } from "../inventory/count-policy.ts";
import { recordSecondCount } from "../inventory/second-count.ts";

/** A real tenant operator with the inventory permissions exercised by command tests. */
export async function createInventoryOperator(
  orgId: string,
  name: string,
): Promise<string> {
  const actorId = await createScratchUser(orgId, name, "inventory_operator");
  await grantInventoryOperator(orgId, actorId);
  return actorId;
}

export async function grantInventoryOperator(
  orgId: string,
  actorId: string,
): Promise<void> {
  const changed =
    await db.execute(sql`update app_roles set permissions='["items.read","items.post","items.manage"]'::jsonb
    where org_id=${orgId} and id in (select role_id from role_assignments where org_id=${orgId} and user_id=${actorId}) returning id`);
  assert.ok(
    changed.rows.length,
    "inventory operator must have an explicit role grant",
  );
}

/** Existing lifecycle probes supply a genuine second observation when their variance needs one. */
export async function confirmCountObservation(
  orgId: string,
  countId: string,
  lineId: string,
  quantity: string,
  actorId?: string,
): Promise<void> {
  const line = (
    await db.execute<{
      expected: string;
      first: string | null;
      tolerance: string | null;
    }>(sql`
    select expected_quantity::text as expected,first_counted_quantity::text as first,variance_tolerance::text as tolerance
    from stock_count_lines where org_id=${orgId} and stock_count_id=${countId} and id=${lineId}`)
  ).rows[0];
  assert.ok(line, "count observation must resolve its own line");
  if (!requiresSecondCount(line.expected, line.first, line.tolerance)) return;
  const observer =
    actorId ?? (await createInventoryOperator(orgId, "Count observer"));
  if (actorId) await grantInventoryOperator(orgId, actorId);
  await recordSecondCount(orgId, observer, {
    countId,
    lineId,
    countedQuantity: quantity,
  });
}
