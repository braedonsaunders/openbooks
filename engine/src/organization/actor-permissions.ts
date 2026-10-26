import { extensionPermissionAvailability } from "./extension-permission-availability.ts";
import { sql } from "drizzle-orm";
import {
  db,
  orgContext,
  withBypassContext,
  pinnedTransactionExecutor,
  type SqlExecutor,
} from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { guardRefusalMessage } from "../platform/database-refusal.ts";
import {
  isCataloguePermission,
  permissionSetCovers,
  resolveEffectivePermissions,
} from "./permissions.ts";
import { ScopeNotFoundError } from "./subsidiary-scope.ts";

/**
 * The nil UUID is the engine's system automation principal: it attributes
 * writes the engine performs itself (provider webhooks, payment runs, carrier
 * tracking, sync) on actor columns without a users foreign key. It is never an
 * organization user and holds no permissions of its own.
 */
export const SYSTEM_AUTOMATION_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

export function isSystemAutomationActor(actorId: string | null | undefined): boolean {
  return actorId === SYSTEM_AUTOMATION_ACTOR_ID;
}

export type ActorPrincipal = {
  id: string;
  orgId: string;
  name: string;
  email: string;
  isSuperAdmin: boolean;
  isActive: boolean;
};

/** Read only an identity eligible to act in this tenant. Local facts retain
 * the caller transaction; foreign home facts use the bounded identity pool. */
export async function actorPrincipal(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<ActorPrincipal | undefined> {
  const local = (
    await exec.execute<ActorPrincipal>(
      sql`
    select id,org_id as "orgId",name,email,is_super_admin as "isSuperAdmin",is_active as "isActive"
      from users where id=${actorId} and org_id=${orgId}`,
      "objects",
    )
  )[0];
  if (local) return local;
  const member =
    (
      await exec.execute<{ present: boolean }>(
        sql`
    select exists(select 1 from role_assignments a join app_roles r on r.org_id=a.org_id and r.id=a.role_id
      where a.org_id=${orgId} and a.user_id=${actorId}) as present`,
        "objects",
      )
    )[0]?.present === true;
  // bypass: user-keyed-lookup — only a platform superadmin or established target membership can resolve a foreign home identity.
  return (
    await withBypassContext(() =>
      db.execute<ActorPrincipal>(
        sql`
    select id,org_id as "orgId",name,email,is_super_admin as "isSuperAdmin",is_active as "isActive"
      from users where id=${actorId} and (is_super_admin or ${member})`,
        "objects",
      ),
    )
  )[0];
}

export async function actorIdentity(exec: SqlExecutor, orgId: string, actorId: string) {
  const row = await actorPrincipal(exec, orgId, actorId);
  return row ? { isSuperAdmin: row.isSuperAdmin, isActive: row.isActive } : undefined;
}

/** Identity locks must belong to the same authoritative tenant transaction
 * as the command's financial reads and writes. */
export function assertActorCommandExecutor(tx: SqlExecutor, orgId: string): void {
  const pinned = pinnedTransactionExecutor();
  const scope = orgContext.getStore();
  if (!pinned || (tx !== db && tx !== pinned) || scope?.bypass || scope?.orgId !== orgId) {
    throw new Error(
      "Actor command authority requires the current organization's pinned transaction executor",
    );
  }
}

/** Pin an eligible identity on the command's own transaction. A foreign home
 * row is locked by one server-side command that restores scope before any
 * other statement on the connection can run, including parallel callers. */
export async function lockActorIdentity(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<ActorPrincipal | undefined> {
  assertActorCommandExecutor(tx, orgId);
  if (!isUuid(orgId) || !isUuid(actorId)) return undefined;
  const local = (
    await tx.execute<ActorPrincipal>(
      sql`
    select id,org_id as "orgId",name,email,is_super_admin as "isSuperAdmin",is_active as "isActive"
      from users where org_id=${orgId} and id=${actorId} for share`,
      "objects",
    )
  )[0];
  if (local) return local.isActive ? local : undefined;
  const foreign = await actorPrincipal(tx, orgId, actorId);
  if (!foreign?.isActive) return undefined;
  if (!isUuid(foreign.orgId)) return undefined;
  // The invoker function uses separate internal statements for each RLS scope,
  // restoring the caller scope before another queued query can run.
  try {
    await tx.execute(
      sql`select public.lock_actor_home_identity(${orgId}::uuid, ${actorId}::uuid, ${foreign.orgId}::uuid)`,
    );
  } catch (error) {
    if (guardRefusalMessage(error) === "Actor is not eligible to command this organization") {
      const refusal = new ScopeNotFoundError();
      refusal.cause = error;
      throw refusal;
    }
    throw error;
  }
  // The home row and any membership used above remain locked until the owning
  // transaction ends, so the bounded identity read cannot observe revocation
  // or replacement after the command's authority was established.
  const locked = await actorPrincipal(tx, orgId, actorId);
  if (!locked?.isActive || locked.orgId !== foreign.orgId) return undefined;
  return locked;
}

/**
 * Effective permission check for ENGINE-side authority gates — the deep
 * boundary where no HTTP session exists to run web/lib/authz.ts
 * (posting flows, sandboxed scripts, subledger services).
 *
 * A principal may act only when their live tenant authorization covers the
 * required key: every active user's assigned app_role permission sets are
 * unioned, grant overrides are added, deny overrides win, and wildcard keys
 * match exactly like `web/lib`'s can(). Platform super admins hold every
 * permission in whatever org they are currently in (the documented authz.ts
 * contract); unknown or inactive principals fail closed.
 *
 * Takes an executor so callers already inside an org transaction reuse its
 * connection view (`tx`), and standalone callers pass `db`.
 */
export async function actorHasPermission(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  permission: string,
): Promise<boolean> {
  return permissionFromAuthority(
    permission,
    () => actorIdentity(exec, orgId, actorId),
    () => actorPermissionGrants(exec, orgId, actorId),
    () => extensionPermissionAvailability(orgId, exec),
  );
}

/** One read's native authority facts. Never retain this reader across reads
 * or use it for commands: actorHasPermission re-resolves command authority. */
export function createActorPermissionRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): (permission: string) => Promise<boolean> {
  const identity = once(() => actorIdentity(exec, orgId, actorId));
  const grants = once(() => actorPermissionGrants(exec, orgId, actorId));
  const extensions = once(() => extensionPermissionAvailability(orgId, exec));
  return (permission) => permissionFromAuthority(permission, identity, grants, extensions);
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}

async function permissionFromAuthority(
  permission: string,
  identity: () => ReturnType<typeof actorIdentity>,
  grants: () => ReturnType<typeof actorPermissionGrants>,
  extensions: () => ReturnType<typeof extensionPermissionAvailability>,
): Promise<boolean> {
  const modulePermissions = !isCataloguePermission(permission) ? await extensions() : null;
  if (modulePermissions?.inactive.includes(permission)) return false;
  const row = await identity();
  if (!row?.isActive) return false;
  if (row.isSuperAdmin) return true;

  return permissionSetCovers(
    resolveEffectivePermissions({
      ...(await grants()),
      additionalKnownPermissions: modulePermissions?.active,
    }),
    permission,
  );
}

async function actorPermissionGrants(exec: SqlExecutor, orgId: string, actorId: string) {
  const assignments = await exec.execute<{ permissions: string[] | null }>(
    sql`
    select role.permissions
      from role_assignments assignment
      join app_roles role
        on role.id = assignment.role_id and role.org_id = assignment.org_id
     where assignment.user_id = ${actorId} and assignment.org_id = ${orgId}
  `,
    "objects",
  );
  const overrides = await exec.execute<{
    permission: string;
    effect: "grant" | "deny";
  }>(
    sql`
    select permission, effect
      from user_permission_overrides
     where user_id = ${actorId} and org_id = ${orgId}
  `,
    "objects",
  );
  return {
    rolePermissionSets: assignments.map((r) => (Array.isArray(r.permissions) ? r.permissions : [])),
    overrides,
  };
}
