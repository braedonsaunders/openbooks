import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/src/platform/db.ts";
import { getAuthz, type Authz } from "./authz";
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
export async function lockActiveActor(
  runner: SqlExecutor,
  actorId: string,
): Promise<{ id: string; orgId: string; isSuperAdmin: boolean }> {
  const actor = (await runner.execute<{ id: string; orgId: string; isActive: boolean; isSuperAdmin: boolean }>(sql`
    select id, org_id as "orgId", is_active as "isActive", is_super_admin as "isSuperAdmin"
      from users where id = ${actorId} for update
  `)).rows[0];
  if (!actor || !actor.isActive) {
    throw new Error("Acting user is no longer active — sign in again before retrying this platform change");
  }
  return actor;
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
