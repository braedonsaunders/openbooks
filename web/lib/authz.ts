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
  ])) as unknown as [any, any, any];
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

/**
 * Subsidiary visibility for ONE loaded record — the direct-read/write twin of
 * the list WHERE fragments, so a record hidden from a restricted caller's
 * lists is equally unreachable by id. Unrestricted callers (null set) pass.
 *
 *   - documents/journals/payments/orders/runs: subsidiary_id must be IN the
 *     set; a null subsidiary fails closed, mirroring documentWhere's
 *     `d.subsidiary_id = any(...)`.
 *   - parties carry org-wide identity: their lists expose null-subsidiary
 *     rows (`p.subsidiary_id is null or ...`) — pass orgWideNull for them.
 */
export interface SubsidiaryScopeOptions {
  /** Null-subsidiary rows are org-wide shared (parties), not private. */
  orgWideNull?: boolean;
}

export function subsidiaryScopeAllows(
  scope: ReadonlySet<string> | null,
  subsidiaryId: string | null | undefined,
  opts: SubsidiaryScopeOptions = {},
): boolean {
  if (scope === null) return true;
  if (subsidiaryId === null || subsidiaryId === undefined || subsidiaryId === "") {
    return opts.orgWideNull === true;
  }
  return scope.has(subsidiaryId);
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
