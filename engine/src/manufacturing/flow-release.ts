import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { auditChange } from "./master-support.ts";
import { releaseWorkOrder } from "./work-orders.ts";

/** Approval outcomes are applied inside Flows' organization transaction. */
export async function releaseWorkOrderApproval(args: {
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  const { subjectId, outcome, comment, ctx } = args;
  await assertManufacturingFeature(db, ctx.orgId, "manufacturing");
  const before = (await db.execute<{
    id: string; number: string; status: string; updated_at: Date; updated_by: string | null;
  }>(sql`
    select id, number, status, updated_at, updated_by from mfg_work_orders
     where org_id=${ctx.orgId} and id=${subjectId} for update`)).rows[0];
  if (!before) throw new ManufacturingNotFoundError();
  if (before.status !== "draft") {
    throw new ManufacturingError(`Work order ${before.number} cannot resolve approval from ${before.status}.`, {
      status: 409,
      code: "work_order_approval_state_changed",
      remedy: "Review the work-order audit history and create a new draft if release is still required.",
    });
  }
  if (!ctx.userId) {
    throw new ManufacturingError("A signed-in approver is required to release a work order.", {
      status: 403, code: "approver_required", remedy: "Have an authorized approver decide the work-order approval.",
    });
  }
  const reason = comment?.trim() || null;
  if (outcome === "approved") {
    await releaseWorkOrder(db, ctx.orgId, ctx.userId, subjectId, { fromApproval: true, reason });
    return;
  }
  const updated = await db.execute(sql`
    update mfg_work_orders set updated_by=${ctx.userId}, updated_at=now()
     where org_id=${ctx.orgId} and id=${subjectId} and status='draft' returning id`);
  if (updated.rows.length !== 1) {
    throw new ManufacturingError("The work order changed while its approval was being rejected.", {
      status: 409, code: "work_order_changed", remedy: "Reload the work order and resolve its current approval state.",
    });
  }
  await auditChange(db, {
    orgId: ctx.orgId, actorId: ctx.userId, table: "mfg_work_orders", rowId: subjectId, action: "update",
    before: { status: "pending_approval" },
    after: { status: "draft", reason: reason ?? "Approval rejected." },
  });
}
