import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";

/**
 * The "one login across tenants" resolution layer. A person logs in as their
 * single home `users` row (the login identity). From there they can act in:
 *   - their home production org (implicit),
 *   - any production or preview org granted via `user_org_access` (acting as a mapped row),
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
  envKind: "production" | "preview";
}

interface ActingUserSqlRow { acting_user_id: string }
interface OrgNameSqlRow { name: string }
interface AccessibleOrgSqlRow { orgId: string; actingUserId: string; name: string; envKind: "production" | "preview" }
interface OrgEnvironmentSqlRow {
  id: string;
  name: string;
  envKind: "production" | "sandbox" | "preview";
  sandboxOf: string | null;
  sandboxSeed: string;
}
interface SandboxSqlRow { name: string; status: string }

/** Mirrors the SQL ob_rebase(old, seed) = md5(seed || ':' || old)::uuid so we
 * can derive a member's cloned users row id inside a sandbox without a query. */
export function rebaseUuid(oldId: string, seed: string): string {
  const h = createHash("md5").update(`${seed}:${oldId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The users row this member acts as in a directly reachable org, or null. */
async function actingUserIn(
  home: HomeUser,
  targetOrgId: string,
  envKind: "production" | "preview" = "production",
): Promise<string | null> {
  if (targetOrgId === home.orgId) return home.id;
  const r = (await db.execute(sql`
    select a.acting_user_id from user_org_access a
    join users u on u.id = a.acting_user_id and u.org_id = a.org_id and u.is_active
     where a.member_user_id = ${home.id} and a.org_id = ${targetOrgId} and a.is_active`)) as unknown as { rows: ActingUserSqlRow[] };
  if (r.rows[0]?.acting_user_id) return r.rows[0].acting_user_id;
  // A super administrator may inspect any production tenant using the platform
  // identity. Preview/sample companies still require an explicit mapped user:
  // their copied tenant data must never inherit a cross-tenant user identity.
  return home.isSuperAdmin && envKind === "production" ? home.id : null;
}

/** Every top-level production or explicitly granted preview org the member can reach. */
export async function accessibleProductionOrgs(home: HomeUser): Promise<AccessibleOrg[]> {
  return withBypassContext(async () => {
    if (home.isSuperAdmin) {
      const rows = (await db.execute(sql`
        select id, name from orgs
         where env_kind = 'production'
           and not coalesce((settings->'sampleTemplate'->>'enabled')::boolean, false)
         order by name`));
      const out: AccessibleOrg[] = (rows.rows as unknown as Array<{ id: string; name: string }>).map((o) => ({
        orgId: o.id,
        name: o.name,
        actingUserId: home.id,
        envKind: "production" as const,
      }));
      const previews = (await db.execute(sql`
        select a.org_id as "orgId", a.acting_user_id as "actingUserId", o.name
          from user_org_access a join orgs o on o.id = a.org_id
          join users u on u.id = a.acting_user_id and u.org_id = a.org_id and u.is_active
         where a.member_user_id = ${home.id} and a.is_active and o.env_kind = 'preview'
         order by o.name`)) as unknown as { rows: AccessibleOrgSqlRow[] };
      for (const preview of previews.rows) {
        out.push({ ...preview, envKind: "preview" });
      }
      return out;
    }
    const homeRow = (await db.execute(sql`select name from orgs where id = ${home.orgId}`)) as unknown as { rows: OrgNameSqlRow[] };
    const out: AccessibleOrg[] = [
      {
        orgId: home.orgId,
        name: homeRow.rows[0]?.name ?? "openbooks",
        actingUserId: home.id,
        envKind: "production",
      },
    ];
    const grants = (await db.execute(sql`
      select a.org_id as "orgId", a.acting_user_id as "actingUserId", o.name,
             o.env_kind as "envKind"
        from user_org_access a join orgs o on o.id = a.org_id
          join users u on u.id = a.acting_user_id and u.org_id = a.org_id and u.is_active
       where a.member_user_id = ${home.id} and a.is_active
         and o.env_kind in ('production', 'preview')
       order by o.name`)) as unknown as { rows: AccessibleOrgSqlRow[] };
    for (const g of grants.rows) {
      if (g.orgId === home.orgId) continue;
      out.push({
        orgId: g.orgId,
        name: g.name,
        actingUserId: g.actingUserId,
        envKind: g.envKind,
      });
    }
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
      const o = (await db.execute(sql`select name from orgs where id = ${home.orgId}`)) as unknown as { rows: OrgNameSqlRow[] };
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
        from orgs where id = ${activeOrgId}`)) as unknown as { rows: OrgEnvironmentSqlRow[] };
    const org = orgRes.rows[0];
    if (!org) return null;

    if (org.envKind === "sandbox") {
      const prodId = org.sandboxOf as string;
      const acting = await actingUserIn(home, prodId, "production");
      if (!acting) return null;
      const sb = (await db.execute(sql`
        select name, status from sandboxes where org_id = ${activeOrgId}`)) as unknown as { rows: SandboxSqlRow[] };
      if (!sb.rows[0] || sb.rows[0].status !== "ready") return null;
      const actingUserId = rebaseUuid(acting, org.sandboxSeed);
      const member = await db.execute(sql`
        select id from users
         where id = ${actingUserId} and org_id = ${activeOrgId} and is_active
      `);
      if (!member.rows.length) return null;
      return {
        orgId: activeOrgId,
        actingUserId,
        envKind: "sandbox",
        productionOrgId: prodId,
        name: org.name,
        sandboxName: sb.rows[0].name,
      };
    }

    if (org.envKind !== "production" && org.envKind !== "preview") return null;
    const acting = await actingUserIn(home, activeOrgId, org.envKind);
    if (!acting) return null;
    return {
      orgId: activeOrgId,
      actingUserId: acting,
      envKind: org.envKind,
      productionOrgId: activeOrgId,
      name: org.name,
      sandboxName: org.envKind === "preview" ? org.name : undefined,
    };
  });
}
