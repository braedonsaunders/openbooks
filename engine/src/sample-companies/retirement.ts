import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { loadCatalog } from "../sandbox/catalog.ts";
import { listSandboxS3VersionIds } from "../sandbox/clone.ts";
import { beginTenantRetirement, finishTenantRetirement, parseTenantRetirementRecovery, recordRetirementStorage, recordTenantRetirementFailure, registerTenantRetirement, tenantRetirementStatus } from "../organization/tenant-retirement.ts";
import { sampleRetirementPlan } from "./retirement-plan.ts";
import { retirementDigest } from "./retirement-contract.ts";
import { deleteRetiredTenantRows, retirementFingerprint, retirementOutstandingWork } from "./retirement-data.ts";

type ReviewedPlan = Awaited<ReturnType<typeof sampleRetirementPlan>>;
function readPlan(value: unknown): ReviewedPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Retirement requires the reviewed native plan JSON");
  const plan = value as ReviewedPlan;
  if (plan.version !== 1 || !plan.admissible || !plan.catalogDigest || !/^[0-9a-f]{64}$/.test(plan.digest) || plan.blockers?.length !== 0) throw new Error("Retirement plan is not admissible; resolve its native blockers and review a new plan");
  return plan;
}
/** Admission freezes target mutations; it does not remove any business rows. */
export async function admitSampleRetirement(input: { plan: unknown; recovery: unknown; runId: string; actorId: string }) {
  const reviewed = readPlan(input.plan);
  if (!isUuid(input.runId) || !isUuid(input.actorId)) throw new Error("Retirement admission requires explicit native run and actor UUIDs");
  const recovery = parseTenantRetirementRecovery(input.recovery);
  const live = await sampleRetirementPlan(reviewed.selection);
  if (!live.admissible || live.digest !== reviewed.digest) throw new Error("Retirement plan changed after review. Preserve all companies and obtain a fresh plan and matching recovery evidence.");
  await withMaintenanceTransaction(null, async () => {
    await db.execute(sql`set local lock_timeout='5s'`);
    await db.execute(sql`set local statement_timeout='600000ms'`);
    await registerTenantRetirement({ runId: input.runId, actorId: input.actorId, planDigest: live.digest, catalogDigest: live.catalogDigest!,
      database: live.database, retainOrgIds: live.selection.retainOrgIds, retireOrgIds: live.selection.retireOrgIds, reason: live.selection.reason,
      recovery, reviewedState: live.targetFingerprints });
    // The durable fences now hold every target against concurrent writers.
    // A write between the read-only plan and quarantine invalidates admission.
    if ((await retirementOutstandingWork(live.selection.retireOrgIds)).length) throw new Error("Executable work appeared before quarantine; admission rolled back. Resolve it through native work controls.");
    const catalog = await loadCatalog();
    for (const target of live.targets) {
      const actual = await retirementFingerprint(catalog, target.orgId);
      if (actual.digest !== live.targetFingerprints[target.orgId]?.digest) throw new Error(`Company ${target.orgId} changed before quarantine; admission rolled back. Review fresh recovery evidence.`);
    }
  }, { isolationLevel: "REPEATABLE READ", advisoryLockKey: "tenant-retirement-admission" });
  return tenantRetirementStatus(input.runId);
}
/** Each target is one recoverable transaction, with durable success receipts.
 * A failed target remains quarantined and can be retried with the same run. */
export async function executeSampleRetirement(input: { runId: string; orgId: string; planDigest: string }) {
  if (!isUuid(input.runId) || !isUuid(input.orgId)) throw new Error("Retirement execution requires exact run and tenant UUIDs");
  try { await withMaintenanceTransaction(null, async () => {
    await db.execute(sql`set local lock_timeout='5s'`);
    await db.execute(sql`set local statement_timeout='600000ms'`);
    if (!await beginTenantRetirement(input.runId, input.orgId, input.planDigest)) return;
    const status = await tenantRetirementStatus(input.runId);
    const catalog = await loadCatalog();
    const beforeTarget = await retirementFingerprint(catalog, input.orgId);
    if (beforeTarget.digest !== status.run.reviewed_state[input.orgId]?.digest) throw new Error("Quarantined target differs from its reviewed content fingerprint; nothing was deleted");
    const retainedBefore: Record<string, string> = {};
    for (const id of status.run.retain_ids) retainedBefore[id] = (await retirementFingerprint(catalog, id)).digest;
    const administrativeDeltas = {
      removedSandboxRegistrations: (await db.execute(sql`select id,org_id,production_org_id,status from sandboxes where org_id=${input.orgId}::uuid`)).rows,
      removedAccessCount: (await db.execute<{ count: string }>(sql`select count(*)::text as count from user_org_access where org_id=${input.orgId}::uuid`)).rows[0]?.count,
      survivingAudit: { kind: "tenant_retirement", runId: input.runId, tenantId: input.orgId, planDigest: input.planDigest },
    };
    const s3VersionIds = (await listSandboxS3VersionIds(input.orgId)).sort();
    const storageManifest = { version: 1, orgId: input.orgId, s3VersionIds, objectDeletion: "not-scheduled", recovery: "objects-preserved-under-reviewed-retention", digest: retirementDigest(s3VersionIds) };
    await recordRetirementStorage(input.runId, input.orgId, storageManifest);
    await db.execute(sql`set constraints all deferred`);
    const removed = await deleteRetiredTenantRows(catalog, input.orgId);
    const retainedAfter: Record<string, string> = {};
    for (const id of status.run.retain_ids) {
      retainedAfter[id] = (await retirementFingerprint(catalog, id)).digest;
      if (retainedAfter[id] !== retainedBefore[id]) throw new Error(`Retirement would change retained company ${id}; the complete target transaction was rolled back`);
    }
    await finishTenantRetirement(input.runId, input.orgId, { version: 1, planDigest: input.planDigest, targetBeforeDigest: beforeTarget.digest,
      explicitlyDeletedRows: removed, deletedTableFingerprints: beforeTarget.tables, retainedBefore, retainedAfter, administrativeDeltas, storageManifestDigest: storageManifest.digest, completedAt: new Date().toISOString() });
  }, { isolationLevel: "REPEATABLE READ", advisoryLockKey: `tenant-retirement:${input.orgId}` });
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code ?? "native_refusal";
    try { await recordTenantRetirementFailure(input.runId, input.orgId, input.planDigest, code); }
    catch (auditError) { throw new AggregateError([error, auditError], "Retirement rolled back; recording its refusal also failed. Preserve the original causes and inspect the native run status."); }
    throw error;
  }
  return tenantRetirementStatus(input.runId);
}
