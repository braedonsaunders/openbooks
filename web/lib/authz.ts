import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { currentUser, type SessionUser } from "./auth";
import { permissionSetCovers, resolveEffectivePermissions } from "./permissions";
import { allowedSubsidiaryIds } from "./subsidiaries";

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
  // Super admins hold every permission in whatever org they're currently in.
  if (user.isSuperAdmin) {
    return { user, permissions: new Set<string>(["*"]), allowedSubsidiaryIds: null };
  }
  const [assignments, overrides, allowedSubs] = (await Promise.all([
    db.execute(sql`
      select r.permissions
        from role_assignments a
        join app_roles r on r.id = a.role_id and r.org_id = a.org_id
       where a.user_id = ${user.id} and a.org_id = ${user.orgId}`),
    db.execute(sql`
      select permission, effect
        from user_permission_overrides
       where user_id = ${user.id} and org_id = ${user.orgId}`),
    allowedSubsidiaryIds(user.id),
  ])) as [any, any, Set<string> | null];
  const permissions = resolveEffectivePermissions({
    rolePermissionSets: assignments.rows.map((r: any) =>
      Array.isArray(r.permissions) ? r.permissions : [],
    ),
    overrides: overrides.rows,
  });
  return { user, permissions, allowedSubsidiaryIds: allowedSubs };
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
 * missing the permission → home. Use at the top of server components:
 *
 *   const authz = await requirePermission("admin.users.manage");
 */
export async function requirePermission(perm: string): Promise<Authz> {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  if (!can(authz, perm)) redirect("/");
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
