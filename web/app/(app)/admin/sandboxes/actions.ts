"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { enqueueSandboxOp } from "@openbooks/jobs";
import { buildChangeSet, applyChangeSet } from "@openbooks/engine/src/sandbox/index.ts";
import { getAuthz } from "../../../../lib/authz";
import { can } from "../../../../lib/authz";

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

export async function createSandboxAction(input: {
  name: string;
  tier: "dev" | "masked" | "full" | "as_of";
  asOfPeriodId?: string | null;
}): Promise<void> {
  const authz = await requireManager();
  await enqueueSandboxOp({
    op: "create",
    productionOrgId: authz.user.productionOrgId,
    name: input.name.trim() || "Sandbox",
    tier: input.tier,
    masked: input.tier === "masked",
    asOfPeriodId: input.asOfPeriodId ?? null,
    createdBy: authz.user.id,
  });
  revalidatePath("/admin/sandboxes");
}

async function ownedSandbox(sandboxId: string, productionOrgId: string): Promise<void> {
  const r = (await db.execute(sql`
    select 1 from sandboxes where id = ${sandboxId} and production_org_id = ${productionOrgId}`)) as any;
  if (!r.rows.length) throw new Error("sandbox not found");
}

export async function refreshSandboxAction(sandboxId: string, keepCustomizations: boolean): Promise<void> {
  const authz = await requireManager();
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  await enqueueSandboxOp({ op: "refresh", sandboxId, keepCustomizations });
  revalidatePath("/admin/sandboxes");
}

export async function resetSandboxAction(sandboxId: string): Promise<void> {
  const authz = await requireManager();
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  await enqueueSandboxOp({ op: "reset", sandboxId });
  revalidatePath("/admin/sandboxes");
}

export async function deleteSandboxAction(sandboxId: string): Promise<void> {
  const authz = await requireManager();
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  await enqueueSandboxOp({ op: "delete", sandboxId });
  revalidatePath("/admin/sandboxes");
}

export async function setScheduleAction(sandboxId: string, cadence: string | null): Promise<void> {
  const authz = await requireManager();
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  const value = cadence && ["hourly", "daily", "weekly"].includes(cadence) ? cadence : null;
  await db.execute(sql`update sandboxes set refresh_schedule = ${value} where id = ${sandboxId}`);
  revalidatePath("/admin/sandboxes");
}

export async function promoteSandboxAction(sandboxId: string, name: string): Promise<{ changeSetId: string; itemCount: number }> {
  const authz = await requireManager();
  await ownedSandbox(sandboxId, authz.user.productionOrgId);
  return await buildChangeSet(sandboxId, name.trim() || "Change set", authz.user.id);
}

export async function applyChangeSetAction(changeSetId: string): Promise<void> {
  const authz = await requireManager();
  const r = (await db.execute(sql`select 1 from change_sets where id = ${changeSetId} and org_id = ${authz.user.productionOrgId}`)) as any;
  if (!r.rows.length) throw new Error("change set not found");
  await applyChangeSet(changeSetId);
  revalidatePath("/admin/sandboxes");
}
