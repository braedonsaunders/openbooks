import { sql } from "drizzle-orm";
import { db, orgContext, withMaintenanceTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";

import { parseTenantRetirementRecovery, type TenantRetirementRegistration, type TenantRetirementStatus } from "./tenant-retirement-contract.ts";
export { parseTenantRetirementRecovery } from "./tenant-retirement-contract.ts";
export type { TenantRetirementRecovery, TenantRetirementRegistration, TenantRetirementStatus } from "./tenant-retirement-contract.ts";
const DIGEST = /^[0-9a-f]{64}$/;
function pinnedMaintenance(): void {
  const context = orgContext.getStore();
  if (!context?.txDb || !context.bypass) throw new Error("Tenant retirement requires a pinned cross-tenant maintenance transaction");
}
/** Only used by maintenance entry points, so unapplied schema cannot affect ordinary callers. */
export async function retirementCatalogDigest(): Promise<string> {
  const installed = await db.execute<{ installed: boolean }>(sql`select to_regprocedure('tenant_retirement.openbooks_retirement_catalog_digest()') is not null as installed`);
  if (!installed.rows[0]?.installed) throw new Error("Native tenant retirement migration is not installed; use the coordinated migration lane before planning deletion");
  const result = await db.execute<{ digest: string }>(sql`select tenant_retirement.openbooks_retirement_catalog_digest() as digest`);
  if (!result.rows[0]?.digest) throw new Error("Retirement catalog did not produce a digest");
  return result.rows[0].digest;
}
export async function registerTenantRetirement(input: TenantRetirementRegistration): Promise<string> {
  pinnedMaintenance();
  if (!isUuid(input.runId) || !isUuid(input.actorId) || !DIGEST.test(input.planDigest) || !DIGEST.test(input.catalogDigest)) throw new Error("Retirement registration requires exact native identities and reviewed digests");
  const recovery = parseTenantRetirementRecovery(input.recovery);
  const result = await db.execute<{ id: string }>(sql`select tenant_retirement.openbooks_retirement_register(
    ${input.runId}::uuid,${input.planDigest},${input.catalogDigest},${JSON.stringify(input.database)}::jsonb,
    ${sql.param(input.retainOrgIds)}::uuid[],${sql.param(input.retireOrgIds)}::uuid[],${input.actorId}::uuid,${input.reason},${JSON.stringify(recovery)}::jsonb,${JSON.stringify(input.reviewedState)}::jsonb) as id`);
  if (result.rows[0]?.id !== input.runId) throw new Error("Retirement registration did not return its exact run identity");
  return result.rows[0].id;
}
export async function beginTenantRetirement(runId: string, tenantId: string, digest: string): Promise<boolean> {
  pinnedMaintenance();
  if (!isUuid(runId) || !isUuid(tenantId) || !DIGEST.test(digest)) throw new Error("Retirement requires reviewed run, target and digest");
  const result = await db.execute<{ admitted: boolean }>(sql`select tenant_retirement.openbooks_retirement_begin(${runId}::uuid,${tenantId}::uuid,${digest}) as admitted`);
  if (typeof result.rows[0]?.admitted !== "boolean") throw new Error("Retirement admission returned no decision");
  return result.rows[0].admitted;
}
export async function recordRetirementStorage(runId: string, tenantId: string, manifest: unknown): Promise<void> {
  pinnedMaintenance();
  await db.execute(sql`select tenant_retirement.openbooks_retirement_storage(${runId}::uuid,${tenantId}::uuid,${JSON.stringify(manifest)}::jsonb)`);
}
export async function finishTenantRetirement(runId: string, tenantId: string, receipt: unknown): Promise<void> {
  pinnedMaintenance();
  await db.execute(sql`select tenant_retirement.openbooks_retirement_finish(${runId}::uuid,${tenantId}::uuid,${JSON.stringify(receipt)}::jsonb)`);
}
export async function tenantRetirementStatus(runId: string): Promise<TenantRetirementStatus> {
  if (!isUuid(runId)) throw new Error("Retirement status requires a native run UUID");
  return withMaintenanceTransaction(null, async () => {
    const result = await db.execute<{ result: TenantRetirementStatus }>(sql`select tenant_retirement.openbooks_retirement_status(${runId}::uuid) as result`);
    if (!result.rows[0]?.result) throw new Error("Retirement status returned no receipt");
    return result.rows[0].result;
  });
}

export async function recordTenantRetirementFailure(runId: string, tenantId: string, digest: string, code: string): Promise<void> {
  await withMaintenanceTransaction(null, async () => {
    await db.execute(sql`select tenant_retirement.openbooks_retirement_failure(${runId}::uuid,${tenantId}::uuid,${digest},${code})`);
  });
}

export async function releaseTenantRetirement(input: { runId: string; orgId: string; planDigest: string; actorId: string; reason: string }): Promise<TenantRetirementStatus> {
  if (![input.runId, input.orgId, input.actorId].every(isUuid) || !DIGEST.test(input.planDigest) || input.reason.trim().length < 12) throw new Error("Quarantine release requires exact reviewed identities, digest and an explicit reason");
  await withMaintenanceTransaction(null, async () => {
    await db.execute(sql`set local lock_timeout='5s'`);
    await db.execute(sql`select tenant_retirement.openbooks_retirement_release(${input.runId}::uuid,${input.orgId}::uuid,${input.planDigest},${input.actorId}::uuid,${input.reason})`);
  }, { advisoryLockKey: `tenant-retirement:${input.orgId}` });
  return tenantRetirementStatus(input.runId);
}
