import { actorPrincipal } from "@openbooks/engine/organization/actor-permissions";
import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import {
  db,
  pinnedTransactionExecutor,
  type SqlExecutor,
} from "@openbooks/engine/platform/database";
import {
  denyInactiveExtensionPermissions,
  extensionPermissionAvailability,
} from "@openbooks/engine/organization/authority";
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
export async function resolveUserAuthz(
  user: SessionUser,
  runner: SqlExecutor = db,
): Promise<Authz> {
  // Super admins hold every permission in whatever org they're currently in.
  if (user.isSuperAdmin) {
    const modulePermissions = await extensionPermissionAvailability(user.orgId, runner);
    return {
      user,
      permissions: denyInactiveExtensionPermissions(
        new Set<string>(["*"]),
        modulePermissions.inactive,
      ),
      allowedSubsidiaryIds: null,
    };
  }
  const readModulePermissions = () => extensionPermissionAvailability(user.orgId, runner);
  const readAssignments = () =>
    runner.execute<{ permissions: string[] }>(
      sql`
      select r.permissions
        from role_assignments a
        join app_roles r on r.id = a.role_id and r.org_id = a.org_id
       where a.user_id = ${user.id} and a.org_id = ${user.orgId}`,
      "objects",
    );
  const readOverrides = () =>
    runner.execute<{ permission: string; effect: "grant" | "deny" }>(
      sql`
      select permission, effect
        from user_permission_overrides
       where user_id = ${user.id} and org_id = ${user.orgId}`,
      "objects",
    );
  const readAllowedSubs = () => allowedSubsidiaryIds(user.id, user.orgId, runner);
  // The four grant sources are independent reads. On the shared pool they run
  // together, because every request resolves its authority before anything
  // else renders. A transaction (the caller's runner, or the one `db` is
  // pinned to) is one pg client, so its reads stay sequential rather than
  // queueing concurrently on that client.
  const [modulePermissions, assignments, overrides, allowedSubs] =
    runner === db && !pinnedTransactionExecutor()
      ? await Promise.all([
          readModulePermissions(),
          readAssignments(),
          readOverrides(),
          readAllowedSubs(),
        ])
      : [
          await readModulePermissions(),
          await readAssignments(),
          await readOverrides(),
          await readAllowedSubs(),
        ];
  const inactivePermissions = modulePermissions.inactive;
  const permissions = resolveEffectivePermissions({
    additionalKnownPermissions: modulePermissions.active,
    rolePermissionSets: assignments.map((r) => (Array.isArray(r.permissions) ? r.permissions : [])),
    overrides,
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
export async function resolveAuthzByUserId(
  orgId: string,
  userId: string,
  runner: SqlExecutor = db,
): Promise<Authz | null> {
  // List sections, drawers and actions of one server render each re-resolve
  // the viewer; they share one snapshot per render, like getAuthz. A caller's
  // transaction runner always resolves on its own client.
  return runner === db ? renderAuthzByUserId(orgId, userId) : authzByUserId(orgId, userId, runner);
}

const renderAuthzByUserId = cache((orgId: string, userId: string) =>
  authzByUserId(orgId, userId, db),
);

async function authzByUserId(
  orgId: string,
  userId: string,
  runner: SqlExecutor,
): Promise<Authz | null> {
  const row = await actorPrincipal(runner, orgId, userId);
  if (!row?.isActive) return null;
  return resolveUserAuthz(
    {
      id: row.id,
      email: row.email,
      name: row.name,
      orgId,
      roles: [],
      envKind: "production",
      productionOrgId: orgId,
      homeUserId: row.id,
      homeOrgId: row.orgId,
      isSuperAdmin: row.isSuperAdmin,
    },
    runner,
  );
}

/** Wildcard-aware permission check (`ap.*` covers `ap.post`, `*` covers all). */
export function can(authz: Authz, perm: string): boolean {
  return permissionSetCovers(authz.permissions, perm);
}

/**
 * Write-body counterpart: true when EVERY explicitly requested subsidiary id
 * is inside the caller's scope. Undefined/null entries mean "leave as-is /
 * resolve at posting" and are checked by the caller's record-level gate, not
 * here. Restricted callers may never assign a record to a subsidiary they
 * cannot see — even one that exists and is active.
 *
 * Lives with the authority snapshot so route modules can apply it without
 * loading the HTTP session resolver.
 */
export function subsidiariesInScope(
  authz: Authz,
  ids: readonly (string | null | undefined)[],
): boolean {
  const scope = authz.allowedSubsidiaryIds;
  if (scope === null) return true;
  return ids.every((id) => id !== null && id !== undefined && id !== "" && scope.has(id));
}
