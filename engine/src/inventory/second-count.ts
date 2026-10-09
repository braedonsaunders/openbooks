import { requireExecutionConfirmation } from "./execution-authority.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { cmp } from "../money/money.ts";
import { InventoryError } from "./contracts.ts";
import { assertInventoryFeature } from "./profile-policy.ts";
import {
  loadCountHeader,
  parseCountQuantity,
  assertCountedNonNegative,
} from "./stock-count-gates.ts";
import { requiresSecondCount } from "./count-policy.ts";

/** A second physical observation preserves the first and never re-snapshots expected stock. */
export async function recordSecondCount(
  orgId: string,
  actorId: string | null,
  input: {
    countId: string;
    lineId: string;
    countedQuantity: string;
    reason?: string | null;
    executionTaskId?:string;
  },
) {
  const quantity = parseCountQuantity(
    input.countedQuantity,
    "second counted quantity",
  );
  assertCountedNonNegative(quantity);
  if (!actorId)
    throw new InventoryError("Record a second count with a named user");
  return db.transaction(async (tx) => {
    if (!(await actorHasPermission(tx, orgId, actorId, "items.post")))
      throw new ScopeNotFoundError();
    await assertInventoryFeature(tx, orgId);
    const subject = await loadCountHeader(tx, orgId, input.countId, false);
    await lockActorCommandAuthority(
      tx,
      orgId,
      actorId,
      subject.subsidiaryId,
      "items.post",
    );
    const header = await loadCountHeader(tx, orgId, input.countId, true);
    if (header.subsidiaryId !== subject.subsidiaryId)
      throw new InventoryError("Count legal entity changed — reload and retry");
    if (header.status !== "counting")
      throw new InventoryError(
        "Return the count to counting before recording a second count",
      );
    const before = (
      await tx.execute<{
        expected_quantity: string;
        first_counted_quantity: string | null;
        variance_tolerance: string | null;
        second_counted_quantity: string | null;
        serial_id: string | null;
      }>(sql`
      select serial_id,expected_quantity::text,first_counted_quantity::text,variance_tolerance::text,second_counted_quantity::text from stock_count_lines
      where org_id=${orgId} and stock_count_id=${header.id} and id=${input.lineId} and adjustment_movement_id is null for update`)
    ).rows[0];
    if (!before || before.first_counted_quantity === null)
      throw new InventoryError(
        "Record the first count before the second observation",
      );
    if (
      !requiresSecondCount(
        before.expected_quantity,
        before.first_counted_quantity,
        before.variance_tolerance,
      )
    )
      throw new InventoryError("This line does not require a second count");
    if (
      before.serial_id &&
      cmp(quantity, "0") !== 0 &&
      cmp(quantity, "1") !== 0
    )
      throw new InventoryError("Count one serial as present (1) or absent (0)");
    await requireExecutionConfirmation(tx,orgId,{stage:"count",taskId:input.executionTaskId,lineId:input.lineId,quantity,observation:"second"});
    const reason = input.reason?.trim() ?? "";
    if (cmp(quantity, before.first_counted_quantity) !== 0 && reason.length < 5)
      throw new InventoryError(
        "Explain why the second count differs from the first (at least 5 characters)",
      );
    if (reason.length > 500)
      throw new InventoryError(
        "Second count reason must be at most 500 characters",
      );
    const changed =
      await tx.execute(sql`update stock_count_lines set counted_quantity=${quantity},second_counted_quantity=${quantity},
      second_counted_by=${actorId},second_counted_at=now(),updated_by=${actorId},updated_at=now()
      where org_id=${orgId} and id=${input.lineId} and stock_count_id=${header.id} returning id`);
    if (!changed.rows.length)
      throw new InventoryError("Count line changed — reload and retry");
    const audit =
      await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},'stock_count_lines',${input.lineId},'update',
      ${JSON.stringify({ operation: "second_count", countId: header.id, reason: reason || "Independent physical observation", before, after: { secondCountedQuantity: quantity } })}::jsonb,${actorId}) returning id`);
    if (!audit.rows.length)
      throw new InventoryError("Second count was not audited");
    return { lineId: input.lineId, secondCountedQuantity: quantity };
  });
}
