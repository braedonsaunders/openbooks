import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";

/**
 * The "one login across tenants" resolution layer. A person logs in as their
 * single home `users` row (the login identity). From there they can act in:
 *   - their home production org (implicit),
 *   - any production org granted via `user_org_access` (acting as a mapped row),
 *   - any org at all if they are a super admin,
 *   - and any sandbox of an org they can reach (acting as the deterministic
 *     rebase of their production users row — sandboxes are separate tenants).
 *
 * All resolution runs under bypass because it spans orgs and happens during the
 * pre-context auth bootstrap.
 */

export interface HomeUser {
  id: string;
  orgId: string;
  isSuperAdmin: boolean;
}

export interface ResolvedEnv {
  /** Effective org for the request. */
  orgId: string;
  /** The users row to act as in that org (RLS/authz key). */
  actingUserId: string;
  envKind: "production" | "sandbox" | "preview";
  /** Production org backing the active env (itself when a production org). */
  productionOrgId: string;
  /** Display name of the active org/sandbox. */
  name: string;
  sandboxName?: string;
}

export interface AccessibleOrg {
  orgId: string;
  name: string;
  actingUserId: string;
}

/** Mirrors the SQL ob_rebase(old, seed) = md5(seed || ':' || old)::uuid so we
 * can derive a member's cloned users row id inside a sandbox without a query. */
export function rebaseUuid(oldId: string, seed: string): string {
  const h = createHash("md5").update(`${seed}:${oldId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The users row this member acts as in a production org, or null if no access. */
async function actingUserIn(home: HomeUser, prodOrgId: string): Promise<string | null> {
  if (prodOrgId === home.orgId) return home.id;
  if (home.isSuperAdmin) return home.id; // super admin acts as their home identity
  const r = (await db.execute(sql`
    select acting_user_id from user_org_access
     where member_user_id = ${home.id} and org_id = ${prodOrgId} and is_active`)) as any;
  return r.rows[0]?.acting_user_id ?? null;
}

/** Every PRODUCTION org the member can reach, with the acting row per org. */
export async function accessibleProductionOrgs(home: HomeUser): Promise<AccessibleOrg[]> {
  return withBypassContext(async () => {
    if (home.isSuperAdmin) {
      const rows = (await db.execute(sql`
        select id, name from orgs where env_kind = 'production' order by name`)) as any;
      return rows.rows.map((o: any) => ({ orgId: o.id, name: o.name, actingUserId: home.id }));
    }
    const homeRow = (await db.execute(sql`select name from orgs where id = ${home.orgId}`)) as any;
    const out: AccessibleOrg[] = [
      { orgId: home.orgId, name: homeRow.rows[0]?.name ?? "openbooks", actingUserId: home.id },
    ];
    const grants = (await db.execute(sql`
      select a.org_id as "orgId", a.acting_user_id as "actingUserId", o.name
        from user_org_access a join orgs o on o.id = a.org_id
       where a.member_user_id = ${home.id} and a.is_active and o.env_kind = 'production'
       order by o.name`)) as any;
    for (const g of grants.rows) out.push({ orgId: g.orgId, name: g.name, actingUserId: g.actingUserId });
    return out;
  });
}

/** Resolve the effective environment for an active-org id (or home if null). */
export async function resolveActiveEnv(
  home: HomeUser,
  activeOrgId: string | null,
): Promise<ResolvedEnv | null> {
  return withBypassContext(async () => {
    if (!activeOrgId || activeOrgId === home.orgId) {
      const o = (await db.execute(sql`select name from orgs where id = ${home.orgId}`)) as any;
      return {
        orgId: home.orgId,
        actingUserId: home.id,
        envKind: "production",
        productionOrgId: home.orgId,
        name: o.rows[0]?.name ?? "openbooks",
      };
    }
    const orgRes = (await db.execute(sql`
      select id, name, env_kind as "envKind", sandbox_of as "sandboxOf", sandbox_seed as "sandboxSeed"
        from orgs where id = ${activeOrgId}`)) as any;
    const org = orgRes.rows[0];
    if (!org) return null;

    if (org.envKind === "sandbox") {
      const prodId = org.sandboxOf as string;
      const acting = await actingUserIn(home, prodId);
      if (!acting) return null;
      const sb = (await db.execute(sql`
        select name, status from sandboxes where org_id = ${activeOrgId}`)) as any;
      if (!sb.rows[0] || sb.rows[0].status !== "ready") return null;
      return {
        orgId: activeOrgId,
        actingUserId: rebaseUuid(acting, org.sandboxSeed),
        envKind: "sandbox",
        productionOrgId: prodId,
        name: org.name,
        sandboxName: sb.rows[0].name,
      };
    }

    // production org (not home)
    const acting = await actingUserIn(home, activeOrgId);
    if (!acting) return null;
    return {
      orgId: activeOrgId,
      actingUserId: acting,
      envKind: "production",
      productionOrgId: activeOrgId,
      name: org.name,
    };
  });
}
