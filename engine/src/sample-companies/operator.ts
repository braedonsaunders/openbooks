import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db, orgContext, withBypassContext, withMaintenanceTransaction, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { actorIdentity, actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { sampleCompanyFeatures } from "./features.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

export interface SampleOperatorOptions { actorId?: string }
const pinned = new AsyncLocalStorage<{ orgId: string; actorId: string; foreignIdentityLocked: boolean }>();
export function sampleOperatorId(options: SampleOperatorOptions): string | undefined {
  if (options.actorId === undefined) return undefined;
  if (!isUuid(options.actorId)) throw new SampleCompanyError("Sample operator must be an explicit native user UUID; pass --actor UUID from the reviewed operator inventory.");
  return options.actorId.toLowerCase();
}
export function sampleOperatorPermissions(industryKey: string): string[] {
  const f = sampleCompanyFeatures(industryKey);
  return ["admin.setup.manage", "documents.manage", "gl.manage", "gl.post", "ap.create", "ap.post", "ap.pay", "ar.create", "ar.post", "ar.pay", "banking.reconcile",
    ...(f.inventory ? ["items.manage", "items.post"] : []),
    ...(f.hrmTraining ? ["hrm.certifications.manage"] : []),
    ...(f.hrmShiftPlanning ? ["hrm.shifts.manage"] : []),
    ...(f.hrmAttendance ? ["hrm.attendance.manage"] : []),
    ...(f.compensationPackages ? ["payroll.manage"] : [])];
}

/** A foreign platform identity is locked separately while tenant writes retain
 * their ordinary scoped connection. No existing role or grant is changed. */
export async function withSampleOperator<T>(orgId: string, options: SampleOperatorOptions, command: () => Promise<T>): Promise<T> {
  const actorId = sampleOperatorId(options);
  if (!actorId) return command();
  const prior = pinned.getStore();
  if (prior) {
    if (prior.orgId !== orgId || prior.actorId !== actorId) throw new SampleCompanyError("Sample operator identity cannot change inside an active command.");
    return command();
  }
  const readLocal = async () => (await db.execute(sql`select id from users where id=${actorId} and org_id=${orgId}`)).rows.length === 1;
  const local = orgContext.getStore()?.txDb ? await readLocal() : await withOrgContext(orgId, readLocal);
  if (local) return pinned.run({ orgId, actorId, foreignIdentityLocked: false }, command);
  if (orgContext.getStore()?.txDb) throw new SampleCompanyError("Start a platform-operated sample command at its native entry point so the selected home identity can remain locked for the complete tenant transaction.");
  // Native authentication admits a home identity outside the target tenant;
  // keep that exact user's active/superadmin state stable until the command ends.
  return withBypassContext(() => withMaintenanceTransaction(null, async () => {
    const locked = (await db.execute(sql`select id from users where id=${actorId} for share`)).rows;
    const identity = await actorIdentity(db, orgId, actorId);
    if (locked.length !== 1 || !identity?.isActive || !identity.isSuperAdmin) throw new SampleCompanyError("The selected sample operator must be active in the target company or be an active platform superadmin. Select an authorized --actor; sample preparation never grants permissions.");
    return withOrgContext(orgId, () => pinned.run({ orgId, actorId, foreignIdentityLocked: true }, command));
  }));
}

/** Re-read native authority under the command's identity, role and scope locks. */
export async function assertSampleOperator(tx: SqlExecutor, orgId: string, actorId: string, subsidiaryId: string, industryKey: string, lock: boolean): Promise<void> {
  const local = (await tx.execute<{ id: string }>(sql`select id from users where org_id=${orgId} and id=${actorId} ${lock ? sql`for share` : sql``}`)).rows[0];
  const identity = await actorIdentity(tx, orgId, actorId);
  if (!identity?.isActive || (!local && !identity.isSuperAdmin)) throw new SampleCompanyError("The selected sample operator is unavailable in this company. Choose an active authorized local user or explicitly supply a platform superadmin with --actor UUID.");
  if (lock && !local && (pinned.getStore()?.actorId !== actorId || pinned.getStore()?.orgId !== orgId || !pinned.getStore()?.foreignIdentityLocked)) throw new SampleCompanyError("Foreign sample operator identity must remain locked through the native sample command entry point.");
  const f = sampleCompanyFeatures(industryKey);
  if (!local && (f.hrmTraining || f.hrmShiftPlanning)) throw new SampleCompanyError("Training and roster authorship require a user and person identity in this company. Use a native audited operator authorization to select a local author, then review an industry-specific refresh-plan with that --actor; a foreign platform identity cannot replace native authorship.");
  for (const permission of sampleOperatorPermissions(industryKey)) {
    if (lock) {
      try { await lockActorCommandAuthority(tx, orgId, actorId, subsidiaryId, permission); }
      catch (error) {
        if (!(error instanceof ScopeNotFoundError)) throw error;
        throw new SampleCompanyError(`Sample operator lacks ${permission} or access to the target legal entity. Select an authorized --actor and review a new refresh-plan; existing grants are preserved.`, { cause: error });
      }
    } else if (!await actorHasPermission(tx, orgId, actorId, permission)) {
      throw new SampleCompanyError(`Sample operator lacks ${permission}. Select an authorized --actor and review a new refresh-plan; existing grants are preserved.`);
    }
  }
  const scope = await actorAllowedSubsidiaryIds(tx, orgId, actorId);
  if (scope !== null && !scope.has(subsidiaryId)) throw new SampleCompanyError("Sample operator cannot access the target legal entity. Select a correctly scoped --actor and review a new refresh-plan.");
}
