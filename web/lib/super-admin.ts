import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/src/platform/db.ts";
import { can, getAuthz, resolveUserAuthz, type Authz } from "./authz";
import { accessDeniedHref } from "./gate-targets";

/**
 * Gate a super-admin surface. Signed out → /login; any other visitor gets
 * the operator-only explanation instead of a silent bounce home.
 */
export async function requireSuperAdmin(): Promise<Authz> {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  if (!authz.user.isSuperAdmin) redirect(accessDeniedHref({ scope: "platform" }));
  return authz;
}

/**
 * API-route twin of requireSuperAdmin: returns the resolved Authz for a
 * platform super-admin, or the 401/403 JSON response the handler sends.
 *
 *   const gate = await guardSuperAdmin();
 *   if (gate instanceof NextResponse) return gate;
 */
export async function guardSuperAdmin(): Promise<Authz | NextResponse> {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!authz.user.isSuperAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return authz;
}

/** Lock the home identity so deactivation and privilege revocation serialize with privileged writes. */
type LockedActor = { id: string; email: string; name: string; orgId: string; isActive: boolean; isSuperAdmin: boolean };

async function lockActorRows(runner: SqlExecutor, actorIds: readonly string[]): Promise<Map<string, LockedActor>> {
  const ids = [...new Set(actorIds)].sort();
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await runner.execute<LockedActor>(sql`
    select id, email, name, org_id as "orgId", is_active as "isActive", is_super_admin as "isSuperAdmin"
      from users where id in (${idList}) order by id for update
  `)).rows;
  const actors = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== ids.length || rows.some((row) => !row.isActive)) {
    throw new Error("Acting user is no longer active — sign in again before retrying this protected change");
  }
  return actors;
}

export async function lockActiveActor(
  runner: SqlExecutor,
  actorId: string,
): Promise<{ id: string; orgId: string; isSuperAdmin: boolean }> {
  return lockActorRows(runner, [actorId]).then((actors) => {
    const actor = actors.get(actorId)!;
    return { id: actor.id, orgId: actor.orgId, isSuperAdmin: actor.isSuperAdmin };
  });
}

/** Revalidate super-admin authority while holding the actor row lock through the caller's mutation. */
export async function lockSuperAdminActor(
  runner: SqlExecutor,
  actorId: string,
): Promise<{ id: string; orgId: string; isSuperAdmin: true }> {
  const actor = await lockActiveActor(runner, actorId);
  if (!actor.isSuperAdmin) {
    throw new Error("Platform super-admin access was revoked — reload and retry with an active super administrator");
  }
  return { ...actor, isSuperAdmin: true };
}

/** Lock the acting and home identities, then resolve current org permission under the same transaction. */
export async function lockActorPermission(
  runner: SqlExecutor,
  staleAuthz: Authz,
  permission: string,
  options: { requireUnrestrictedScope?: boolean } = {},
): Promise<Authz> {
  const locked = await lockActorRows(runner, [staleAuthz.user.homeUserId, staleAuthz.user.id]);
  const home = locked.get(staleAuthz.user.homeUserId)!;
  const acting = locked.get(staleAuthz.user.id)!;

  // Prevent role/override revocation from committing between this fresh read
  // and the protected write. The actor rows are locked first in stable order.
  await runner.execute(sql`
    select id from role_assignments where org_id = ${staleAuthz.user.orgId} and user_id = ${acting.id}
     order by id for share
  `);
  await runner.execute(sql`
    select id from app_roles
     where org_id = ${staleAuthz.user.orgId}
       and id in (select role_id from role_assignments where org_id = ${staleAuthz.user.orgId} and user_id = ${acting.id})
     order by id for share
  `);
  await runner.execute(sql`
    select id from user_permission_overrides where org_id = ${staleAuthz.user.orgId} and user_id = ${acting.id}
     order by id for share
  `);

  const fresh = await resolveUserAuthz({
    ...staleAuthz.user,
    email: acting.email,
    name: acting.name,
    isSuperAdmin: home.isSuperAdmin,
  }, runner);
  if (!can(fresh, permission)) {
    throw new Error(`Missing permission: ${permission} — reload after an administrator restores access`);
  }
  if (options.requireUnrestrictedScope && fresh.allowedSubsidiaryIds !== null) {
    throw new Error("Protected connection changes require unrestricted subsidiary access — restore the full scope and retry");
  }
  return fresh;
}
