import "server-only";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/database";
import { denyInactiveExtensionPermissions, extensionPermissionAvailability } from "@openbooks/engine/organization/authority";
import type { SessionUser } from "./auth";
import { permissionSetCovers, resolveEffectivePermissions } from "./permissions";
import { allowedSubsidiaryIds } from "./subsidiaries";

/** Live actor authority shared by HTTP requests and standalone background workers. */
export interface Authz {
  user: SessionUser;
  permissions: Set<string>;
  /** Subsidiaries the user may see, from their roles' restrictions; null = unrestricted. */
  allowedSubsidiaryIds: Set<string> | null;
}

/** Resolve current grants for a verified active identity, including scheduled execution. */
export async function resolveUserAuthz(user: SessionUser, runner: SqlExecutor = db): Promise<Authz> {
  const modulePermissions = await extensionPermissionAvailability(user.orgId, runner);
  const inactivePermissions = modulePermissions.inactive;
  // Super admins hold every permission in whatever org they're currently in.
  if (user.isSuperAdmin) {
    return { user, permissions: denyInactiveExtensionPermissions(new Set<string>(["*"]), inactivePermissions), allowedSubsidiaryIds: null };
  }
  // Sequential reads: callers inside an org transaction pass its single
  // pg client as runner, so fanning out queues concurrent queries on it.
  const assignments = await runner.execute<{ permissions: string[] }>(sql`
      select r.permissions
        from role_assignments a
        join app_roles r on r.id = a.role_id and r.org_id = a.org_id
       where a.user_id = ${user.id} and a.org_id = ${user.orgId}`)
  const overrides = await runner.execute<{ permission: string; effect: "grant" | "deny" }>(sql`
      select permission, effect
        from user_permission_overrides
       where user_id = ${user.id} and org_id = ${user.orgId}`)
  const allowedSubs = await allowedSubsidiaryIds(user.id, user.orgId)
  const permissions = resolveEffectivePermissions({
    additionalKnownPermissions: modulePermissions.active,
    rolePermissionSets: assignments.rows.map((r) =>
      Array.isArray(r.permissions) ? r.permissions : [],
    ),
    overrides: overrides.rows,
  });
  denyInactiveExtensionPermissions(permissions, inactivePermissions);
  return { user, permissions, allowedSubsidiaryIds: allowedSubs };
}

/**
 * Re-resolve grants for a known user id at execution time (flow approval
 * releases, scheduled runs): never trust a saved permission set.
 * Deactivation or revocation fails closed — null means "no authority", and
 * callers must treat null as holding no permission.
 */
export async function resolveAuthzByUserId(orgId: string, userId: string): Promise<Authz | null> {
  const row = (await db.execute<{
    id: string; email: string; name: string; org_id: string; is_super_admin: boolean
  }>(sql`
    select u.id, u.email, u.name, u.org_id, u.is_super_admin from users u
     where u.id = ${userId} and u.is_active
       and (u.org_id = ${orgId} or u.is_super_admin or exists (
         select 1 from role_assignments a where a.user_id = u.id and a.org_id = ${orgId}
       ))
  `)).rows[0];
  if (!row) return null;
  return resolveUserAuthz({
    id: row.id,
    email: row.email,
    name: row.name,
    orgId,
    roles: [],
    envKind: "production",
    productionOrgId: orgId,
    homeUserId: row.id,
    homeOrgId: row.org_id,
    isSuperAdmin: row.is_super_admin,
  });
}

/** Wildcard-aware permission check (`ap.*` covers `ap.post`, `*` covers all). */
export function can(authz: Authz, perm: string): boolean {
  return permissionSetCovers(authz.permissions, perm);
}
