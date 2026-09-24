import "server-only";
import { denyInactiveExtensionPermissions, extensionPermissionAvailability } from "@openbooks/engine/src/organization/extension-permission-availability.ts";
import {
  assertUnrestrictedScope,
  subsidiaryScopeAllows,
  type SubsidiaryScopeOptions,
  UNRESTRICTED_SCOPE_REQUIRED,
  UnrestrictedScopeError,
} from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { currentUser, type SessionUser } from "./auth";
import { accessDeniedHref } from "./gate-targets";
import { permissionSetCovers, resolveEffectivePermissions } from "./permissions";
import { allowedSubsidiaryIds } from "./subsidiaries";

export {
  subsidiaryScopeAllows,
  type SubsidiaryScopeOptions,
} from "@openbooks/engine/src/organization/subsidiary-scope.ts";

/**
 * Server-side authorization on top of the existing HMAC-cookie session.
 * currentUser() stays the identity source; this layer resolves the user's
 * EFFECTIVE permissions:
 *
 *   1. union of every explicitly assigned app_role's permission keys;
 *   2. apply user_permission_overrides — grants add, denies win.
 * A user without an assigned role has no role-granted permissions.
 */

export interface Authz {
  user: SessionUser;
  permissions: Set<string>;
  /** Subsidiaries the user may see, from their roles' restrictions; null = unrestricted. */
  allowedSubsidiaryIds: Set<string> | null;
}

export async function getAuthz(): Promise<Authz | null> {
  const user = await currentUser();
  if (!user) return null;
  return resolveUserAuthz(user);
}

/** Resolve current grants for a verified active identity, including scheduled execution. */
export async function resolveUserAuthz(user: SessionUser): Promise<Authz> {
  const modulePermissions = await extensionPermissionAvailability(user.orgId);
  const inactivePermissions = modulePermissions.inactive;
  // Super admins hold every permission in whatever org they're currently in.
  if (user.isSuperAdmin) {
    return { user, permissions: denyInactiveExtensionPermissions(new Set<string>(["*"]), inactivePermissions), allowedSubsidiaryIds: null };
  }
  const [assignments, overrides, allowedSubs] = (await Promise.all([
    db.execute<{ permissions: string[] }>(sql`
      select r.permissions
        from role_assignments a
        join app_roles r on r.id = a.role_id and r.org_id = a.org_id
       where a.user_id = ${user.id} and a.org_id = ${user.orgId}`),
    db.execute<{ permission: string; effect: "grant" | "deny" }>(sql`
      select permission, effect
        from user_permission_overrides
       where user_id = ${user.id} and org_id = ${user.orgId}`),
    allowedSubsidiaryIds(user.id, user.orgId),
  ]));
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

export class ForbiddenError extends Error {
  readonly name = "ForbiddenError";
  readonly status = 403;
  constructor(public readonly permission: string) {
    super(`Missing permission: ${permission}`);
  }
}

export class UnauthorizedError extends Error {
  readonly name = "UnauthorizedError";
  readonly status = 401;
  constructor() {
    super("Not signed in");
  }
}

export function assertCan(authz: Authz, perm: string): void {
  if (!can(authz, perm)) throw new ForbiddenError(perm);
}

/**
 * Page gate. Resolves authz or navigates away: signed out → /login,
 * missing the permission → the access-denied explanation (which permission,
 * who can grant it) instead of a silent bounce home. Use at the top of
 * server components:
 *
 *   const authz = await requirePermission("admin.users.manage");
 */
export async function requirePermission(perm: string): Promise<Authz> {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  if (!can(authz, perm)) redirect(accessDeniedHref({ permission: perm }));
  return authz;
}

/**
 * API-route gate. Returns the resolved Authz, or the 401/403 JSON response
 * the handler should send:
 *
 *   const gate = await guardPermission("ap.create");
 *   if (gate instanceof NextResponse) return gate;
 *   const { user } = gate;
 */
export async function guardPermission(perm: string): Promise<Authz | NextResponse> {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 });
  }
  return authz;
}

/**
 * Direct-record API gate over subsidiary scope. Returns the 404 response the
 * handler must send when the loaded record sits outside the caller's
 * subsidiary scope, or null when access may proceed. The denial is
 * deliberately identical to the nonexistent/cross-org response so an
 * out-of-scope record is indistinguishable from a missing one:
 *
 *   const row = ...select ... where id = ${id} and org_id = ${orgId};
 *   if (!row) return not-found;
 *   const denied = guardSubsidiaryScope(authz, row.subsidiaryId);
 *   if (denied) return denied;
 *
 * (The `subsidiaryScopeAllows` predicate this gate applies lives in the
 * canonical engine scope module and is re-exported above.)
 */
export function guardSubsidiaryScope(
  authz: Authz,
  subsidiaryId: string | null | undefined,
  opts: SubsidiaryScopeOptions = {},
): NextResponse | null {
  if (subsidiaryScopeAllows(authz.allowedSubsidiaryIds, subsidiaryId, opts)) return null;
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

/**
 * Org-wide configuration gate (canonical shape 2). Surfaces whose rows carry
 * no subsidiary lineage (provider configs, quotas, dunning policy, agent
 * runs, report classification, org-wide pricing setup) act on every entity at
 * once, so a subsidiary-restricted caller must never reach their writes — and,
 * where the read itself discloses cross-entity material, their reads either.
 * Unlike record-level denials (uniform 404: the record is hidden), the record
 * here is visible and only the scope is lacking, so the refusal names its
 * remedy: a 403 `requires unrestricted subsidiary access`.
 */
export function guardUnrestrictedScope(authz: Authz): NextResponse | null {
  try {
    assertUnrestrictedScope(authz.allowedSubsidiaryIds);
  } catch (error) {
    if (error instanceof UnrestrictedScopeError) {
      return NextResponse.json({ error: UNRESTRICTED_SCOPE_REQUIRED }, { status: 403 });
    }
    throw error;
  }
  return null;
}

/**
 * Gate an org-wide payroll configuration surface through the org's root
 * subsidiary. Payroll settings and statutory-rate configuration have no row
 * subsidiary of their own, but their effects are rooted at the legal entity
 * represented by the org root. Restricted callers may use those surfaces only
 * when the root is inside their allowed set; an unresolved root fails closed.
 */
export async function guardRootSubsidiaryScope(authz: Authz): Promise<NextResponse | null> {
  if (authz.allowedSubsidiaryIds === null) return null;
  const root = (await db.execute<{ id: string }>(sql`
    select id
      from subsidiaries
     where org_id = ${authz.user.orgId} and parent_id is null and is_active
     order by created_at
     limit 1`)).rows[0]?.id ?? null;
  return guardSubsidiaryScope(authz, root);
}

/**
 * Write-body counterpart: true when EVERY explicitly requested subsidiary id
 * is inside the caller's scope. Undefined/null entries mean "leave as-is /
 * resolve at posting" and are checked by the caller's record-level gate, not
 * here. Restricted callers may never assign a record to a subsidiary they
 * cannot see — even one that exists and is active.
 */
export function subsidiariesInScope(
  authz: Authz,
  ids: readonly (string | null | undefined)[],
): boolean {
  const scope = authz.allowedSubsidiaryIds;
  if (scope === null) return true;
  return ids.every((id) => id !== null && id !== undefined && id !== "" && scope.has(id));
}
