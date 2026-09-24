"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { enqueueSandboxOp } from "@openbooks/jobs";
import {
  applyChangeSet,
  approveChangeSet,
  buildChangeSet,
  reviewChangeSet,
} from "@openbooks/engine/src/sandbox/promote.ts";
import { getAuthz } from "../../../../lib/authz";
import { can } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import type { PromotionTransition } from "../../../../lib/sandbox-promotion";

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new Error(`${label} is invalid`);
}

async function requireManager() {
  const authz = await getAuthz();
  if (!authz) throw new Error("unauthorized");
  if (!can(authz, "admin.sandboxes.manage")) throw new Error("forbidden");
  // Sandboxes are managed from production only.
  if (authz.user.envKind !== "production") {
    throw new Error("exit the sandbox to manage environments");
  }
  return authz;
}

/**
 * Caller-supplied idempotency key for one sandbox operation intent. The UI
 * mints one per form/confirm instance and rotates it after success, so a
 * double-click or retried submit reuses the key and dedupes in BullMQ while
 * a later intentional operation mints a new one. Every enqueue below derives
 * its deterministic jobId from (operation, entity, parameters, key) — never
 * from the clock — so the same intent enqueues exactly one job.
 */
function assertClientOpKey(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw new Error("invalid idempotency key");
  return value;
}

function sandboxOpJobId(op: string, parts: string, clientOpKey: string): string {
  const digest = createHash("sha256").update(op).update("\0").update(parts).update("\0").update(clientOpKey).digest("hex").slice(0, 24);
  return `sbx|${op}|${digest}`;
}

export async function createSandboxAction(input: {
  name: string;
  tier: "dev" | "masked" | "full" | "as_of";
  asOfPeriodId?: string | null;
  clientOpKey: string;
}): Promise<void> {
  const authz = await requireManager();
  const clientOpKey = assertClientOpKey(input.clientOpKey);
  if (input.asOfPeriodId != null) assertUuid(input.asOfPeriodId, "As-of period");
  const name = input.name.trim() || "Sandbox";
  const tier = input.tier;
  const asOfPeriodId = input.asOfPeriodId ?? null;
  await enqueueSandboxOp(
    {
      op: "create",
      productionOrgId: authz.user.productionOrgId,
      name,
      tier,
      masked: tier === "masked",
      asOfPeriodId,
      createdBy: authz.user.id,
    },
    { jobId: sandboxOpJobId("create", `${authz.user.productionOrgId}|${name}|${tier}|${asOfPeriodId ?? ""}`, clientOpKey) },
  );
  revalidatePath("/admin/sandboxes");
}

async function ownedSandbox(sandboxId: string, productionOrgId: string): Promise<string> {
  const r = await db.execute<{ orgId: string }>(sql`
    select org_id as "orgId" from sandboxes where id = ${sandboxId} and production_org_id = ${productionOrgId}`);
  if (!r.rows.length) throw new Error("sandbox not found");
  return r.rows[0]!.orgId;
}

export async function refreshSandboxAction(sandboxId: string, keepCustomizations: boolean, clientOpKey: string): Promise<void> {
  const authz = await requireManager();
  assertUuid(sandboxId, "Sandbox");
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  await enqueueSandboxOp(
    { op: "refresh", sandboxId, keepCustomizations },
    { jobId: sandboxOpJobId("refresh", `${sandboxId}|${keepCustomizations}`, assertClientOpKey(clientOpKey)) },
  );
  revalidatePath("/admin/sandboxes");
}

export async function resetSandboxAction(sandboxId: string, clientOpKey: string): Promise<void> {
  const authz = await requireManager();
  assertUuid(sandboxId, "Sandbox");
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  await enqueueSandboxOp(
    { op: "reset", sandboxId },
    { jobId: sandboxOpJobId("reset", sandboxId, assertClientOpKey(clientOpKey)) },
  );
  revalidatePath("/admin/sandboxes");
}

export async function deleteSandboxAction(sandboxId: string, clientOpKey: string): Promise<void> {
  const authz = await requireManager();
  assertUuid(sandboxId, "Sandbox");
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  await enqueueSandboxOp(
    { op: "delete", sandboxId },
    { jobId: sandboxOpJobId("delete", sandboxId, assertClientOpKey(clientOpKey)) },
  );
  revalidatePath("/admin/sandboxes");
}

export async function setScheduleAction(sandboxId: string, cadence: string | null): Promise<void> {
  const authz = await requireManager();
  assertUuid(sandboxId, "Sandbox");
  const value = cadence && ["hourly", "daily", "weekly"].includes(cadence) ? cadence : null;
  await db.transaction(async (tx) => {
    const existing = await tx.execute<{ orgId: string; refreshSchedule: string | null }>(sql`
      select org_id as "orgId", refresh_schedule as "refreshSchedule"
        from sandboxes
       where id = ${sandboxId} and production_org_id = ${authz.user.productionOrgId}
       for update
    `);
    const before = existing.rows[0];
    if (!before) throw new Error("sandbox not found");
    const updated = await tx.execute(sql`
      update sandboxes
         set refresh_schedule = ${value}, updated_at = now(), updated_by = ${authz.user.id}
       where id = ${sandboxId} and org_id = ${before.orgId}
       returning id
    `);
    if (!updated.rows.length) throw new Error("sandbox not found");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${authz.user.productionOrgId}, 'sandboxes', ${sandboxId}, 'update',
              ${JSON.stringify({
                before: { refresh_schedule: before.refreshSchedule },
                after: { refresh_schedule: value },
              })}::jsonb, ${authz.user.id})
    `);
  });
  revalidatePath("/admin/sandboxes");
}

export async function promoteSandboxAction(sandboxId: string, name: string): Promise<{ changeSetId: string; itemCount: number }> {
  const authz = await requireManager();
  assertUuid(sandboxId, "Sandbox");
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  const result = await buildChangeSet(sandboxId, name.trim() || "Change set", authz.user.id);
  revalidatePath("/admin/sandboxes/change-sets");
  return result;
}

export async function reviewChangeSetAction(changeSetId: string): Promise<void> {
  const authz = await requireManager();
  assertUuid(changeSetId, "Change set");
  const r = await db.execute(sql`
    select 1 from change_sets where id = ${changeSetId} and org_id = ${authz.user.productionOrgId}`);
  if (!r.rows.length) throw new Error("change set not found");
  await reviewChangeSet(changeSetId, authz.user.id);
  revalidatePath("/admin/sandboxes");
}

export async function approveChangeSetAction(changeSetId: string): Promise<void> {
  const authz = await requireManager();
  assertUuid(changeSetId, "Change set");
  const r = await db.execute(sql`
    select 1 from change_sets where id = ${changeSetId} and org_id = ${authz.user.productionOrgId}`);
  if (!r.rows.length) throw new Error("change set not found");
  await approveChangeSet(changeSetId, authz.user.id);
  revalidatePath("/admin/sandboxes");
}

export async function applyChangeSetAction(changeSetId: string): Promise<void> {
  const authz = await requireManager();
  assertUuid(changeSetId, "Change set");
  const r = ((await db.execute(sql`select 1 from change_sets where id = ${changeSetId} and org_id = ${authz.user.productionOrgId}`)));
  if (!r.rows.length) throw new Error("change set not found");
  await applyChangeSet(changeSetId, authz.user.id);
  revalidatePath("/admin/sandboxes");
}

/** Return actionable domain failures without exposing database query details. */
export async function transitionChangeSetAction(changeSetId: string, transition: PromotionTransition): Promise<{ error: string | null }> {
  try {
    if (transition === "review") await reviewChangeSetAction(changeSetId);
    else if (transition === "approve") await approveChangeSetAction(changeSetId);
    else if (transition === "apply") await applyChangeSetAction(changeSetId);
    else throw new Error("Invalid change-set transition");
    revalidatePath("/admin/sandboxes/change-sets");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error && error.constructor === Error
      ? error.message : "The change could not be completed. Refresh the change set and try again." };
  }
}
