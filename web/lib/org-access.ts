import "server-only";
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { permissionSetCovers, resolveEffectivePermissions } from "@openbooks/engine/src/organization/permissions.ts";
import { pgTextArrayLiteral } from "./pg-array";

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

type OrgNameSqlRow = { name: string };
type AccessibleOrgSqlRow = { orgId: string; actingUserId: string; name: string; envKind: "production" | "preview" };
/** One candidate environment with every fact its admission depends on. */
type EnvironmentSqlRow = {
  id: string;
  name: string;
  envKind: "production" | "sandbox" | "preview";
  sandboxOf: string | null;
  /** Home identity or explicit active mapping in the org backing this environment. */
  sourceUserId: string | null;
  sandboxName: string | null;
  sandboxStatus: string | null;
  sandboxTier: string | null;
  sandboxProductionOrgId: string | null;
  /** Role permission sets and overrides of the source user in the production org (sandboxes only). */
  rolePermissions: unknown;
  overrides: { permission: string; effect: "grant" | "deny" }[] | null;
  /** The active cloned users row the source user rebases to (sandboxes only). */
  sandboxUserId: string | null;
};

export interface EnterableSandbox {
  orgId: string;
  productionOrgId: string;
  name: string;
  status: string;
  tier: string;
}

/** Mirrors the SQL ob_rebase(old, seed) = md5(seed || ':' || old)::uuid so we
 * can derive a member's cloned users row id inside a sandbox without a query. */
export function rebaseUuid(oldId: string, seed: string): string {
  const h = createHash("md5").update(`${seed}:${oldId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Read candidate environments together with every fact admission depends on,
 * in one statement for any number of candidates:
 *   - the source identity in the backing org (the environment itself, or a
 *     sandbox's production org): the home identity in the home org, otherwise
 *     an active `user_org_access` mapping onto an active users row;
 *   - for sandboxes, that identity's role permission sets and overrides in the
 *     production org (skipped for super admins, who hold everything), the
 *     sandbox row, and the active users row it rebases to through ob_rebase().
 * Callers run under bypass because candidates span organizations.
 */
async function environmentRows(home: HomeUser, scope: SQL): Promise<EnvironmentSqlRow[]> {
  const result = await db.execute<EnvironmentSqlRow>(sql`
    select o.id, o.name, o.env_kind as "envKind", o.sandbox_of as "sandboxOf",
           source.user_id as "sourceUserId",
           sb.name as "sandboxName", sb.status as "sandboxStatus", sb.tier as "sandboxTier",
           sb.production_org_id as "sandboxProductionOrgId",
           grants.role_permissions as "rolePermissions", grants.overrides,
           member.id as "sandboxUserId"
      from orgs o
      left join sandboxes sb on sb.org_id = o.id
      cross join lateral (
        select case
                 when backing.org_id = ${home.orgId} then ${home.id}::uuid
                 else (select a.acting_user_id
                         from user_org_access a
                         join users u on u.id = a.acting_user_id and u.org_id = a.org_id and u.is_active
                        where a.member_user_id = ${home.id} and a.org_id = backing.org_id and a.is_active
                        limit 1)
               end as user_id
          from (select case when o.env_kind = 'sandbox' then o.sandbox_of else o.id end as org_id) backing
      ) source
      left join lateral (
        select (select coalesce(jsonb_agg(r.permissions), '[]'::jsonb)
                  from role_assignments ra
                  join app_roles r on r.id = ra.role_id and r.org_id = ra.org_id
                 where ra.user_id = source.user_id and ra.org_id = o.sandbox_of) as role_permissions,
               (select coalesce(jsonb_agg(jsonb_build_object('permission', p.permission, 'effect', p.effect)), '[]'::jsonb)
                  from user_permission_overrides p
                 where p.user_id = source.user_id and p.org_id = o.sandbox_of) as overrides
      ) grants on o.env_kind = 'sandbox' and not ${home.isSuperAdmin}::boolean
      left join lateral (
        select m.id from users m
         where m.id = ob_rebase(source.user_id, o.sandbox_seed) and m.org_id = o.id and m.is_active
      ) member on o.env_kind = 'sandbox'
     where ${scope}
     order by sb.created_at, o.id`);
  return result.rows;
}

/**
 * Whether the source identity holds `permission` in the production org right
 * now — the same role-union + override resolution authz uses, evaluated
 * directly (this module runs before Authz exists and must not depend on it).
 */
function sourceUserHolds(row: EnvironmentSqlRow, permission: string): boolean {
  const effective = resolveEffectivePermissions({
    rolePermissionSets: (Array.isArray(row.rolePermissions) ? row.rolePermissions : []).map((set: unknown) =>
      Array.isArray(set) ? set.filter((p): p is string => typeof p === "string") : [],
    ),
    overrides: row.overrides ?? [],
  });
  return permissionSetCovers(effective, permission);
}

/** The environment this member may act in for a candidate row, or null when refused. */
function admittedEnvironment(home: HomeUser, row: EnvironmentSqlRow): ResolvedEnv | null {
  if (row.envKind === "sandbox") {
    // A sandbox needs an actual cloned tenant user. Super-admin's platform
    // identity can inspect production without a tenant mapping, but it is
    // not a valid source identity to rebase into another tenant's sandbox.
    if (!row.sourceUserId || !row.sandboxOf) return null;
    // Entering a sandbox is a privileged act: the member must hold
    // admin.sandboxes.manage in the PRODUCTION org (super admins hold
    // everything). Enforced here — not only in the switcher UI — because
    // this resolver also runs per request from currentUser(), so revoking
    // the permission ejects a member already inside on their next request.
    if (!home.isSuperAdmin && !sourceUserHolds(row, "admin.sandboxes.manage")) return null;
    if (row.sandboxProductionOrgId !== row.sandboxOf || row.sandboxStatus !== "ready" || row.sandboxName === null) return null;
    if (!row.sandboxUserId) return null;
    return {
      orgId: row.id,
      actingUserId: row.sandboxUserId,
      envKind: "sandbox",
      productionOrgId: row.sandboxOf,
      name: row.name,
      sandboxName: row.sandboxName,
    };
  }
  if (row.envKind !== "production" && row.envKind !== "preview") return null;
  // A super administrator may inspect any production tenant using the platform
  // identity. Preview/sample companies still require an explicit mapped user:
  // their copied tenant data must never inherit a cross-tenant user identity.
  const acting = row.sourceUserId ?? (home.isSuperAdmin && row.envKind === "production" ? home.id : null);
  if (!acting) return null;
  return {
    orgId: row.id,
    actingUserId: acting,
    envKind: row.envKind,
    productionOrgId: row.id,
    name: row.name,
    sandboxName: row.envKind === "preview" ? row.name : undefined,
  };
}

/** The member's home production org: always reachable, acting as the login identity. */
export function homeEnvironment(home: HomeUser, orgName: string | undefined): ResolvedEnv {
  return {
    orgId: home.orgId,
    actingUserId: home.id,
    envKind: "production",
    productionOrgId: home.orgId,
    name: orgName ?? "openbooks",
  };
}

/** Every top-level production or explicitly granted preview org the member can reach. */
export async function accessibleProductionOrgs(home: HomeUser): Promise<AccessibleOrg[]> {
  // bypass: user-keyed-lookup — lists every organization this member can reach, across organizations.
  return withBypassContext(async () => {
    if (home.isSuperAdmin) {
      const [orgs, previews] = await Promise.all([
        db.execute<{ id: string; name: string }>(sql`
          select id, name from orgs
           where env_kind = 'production'
             and not coalesce((settings->'sampleTemplate'->>'enabled')::boolean, false)
           order by name`),
        db.execute<AccessibleOrgSqlRow>(sql`
          select a.org_id as "orgId", a.acting_user_id as "actingUserId", o.name
            from user_org_access a join orgs o on o.id = a.org_id
            join users u on u.id = a.acting_user_id and u.org_id = a.org_id and u.is_active
           where a.member_user_id = ${home.id} and a.is_active and o.env_kind = 'preview'
           order by o.name`),
      ]);
      return [
        ...orgs.rows.map((o): AccessibleOrg => ({
          orgId: o.id,
          name: o.name,
          actingUserId: home.id,
          envKind: "production",
        })),
        ...previews.rows.map((preview): AccessibleOrg => ({ ...preview, envKind: "preview" })),
      ];
    }
    const [homeRow, grants] = await Promise.all([
      db.execute<OrgNameSqlRow>(sql`select name from orgs where id = ${home.orgId}`),
      db.execute<AccessibleOrgSqlRow>(sql`
        select a.org_id as "orgId", a.acting_user_id as "actingUserId", o.name,
               o.env_kind as "envKind"
          from user_org_access a join orgs o on o.id = a.org_id
            join users u on u.id = a.acting_user_id and u.org_id = a.org_id and u.is_active
         where a.member_user_id = ${home.id} and a.is_active
           and o.env_kind in ('production', 'preview')
         order by o.name`),
    ]);
    const out: AccessibleOrg[] = [
      {
        orgId: home.orgId,
        name: homeRow.rows[0]?.name ?? "openbooks",
        actingUserId: home.id,
        envKind: "production",
      },
    ];
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

/**
 * The sandboxes of these production orgs that resolveActiveEnv admits the
 * member into, in creation order. One set-based read applies exactly the
 * per-request admission rules, so the switcher never advertises an
 * environment the request resolver would refuse.
 */
export async function enterableSandboxes(home: HomeUser, productionOrgIds: readonly string[]): Promise<EnterableSandbox[]> {
  if (productionOrgIds.length === 0) return [];
  // bypass: user-keyed-lookup — the environment switcher lists sandboxes of every organization this person can reach.
  return withBypassContext(async () => {
    const rows = await environmentRows(home, sql`o.env_kind = 'sandbox' and sb.production_org_id = any(${pgTextArrayLiteral(productionOrgIds)}::uuid[])`);
    return rows.flatMap((row) => admittedEnvironment(home, row) && row.sandboxProductionOrgId !== null
      ? [{
          orgId: row.id,
          productionOrgId: row.sandboxProductionOrgId,
          name: row.sandboxName!,
          status: row.sandboxStatus!,
          tier: row.sandboxTier!,
        }]
      : []);
  });
}

/** Resolve the effective environment for an active-org id (or home if null). */
export async function resolveActiveEnv(
  home: HomeUser,
  activeOrgId: string | null,
): Promise<ResolvedEnv | null> {
  // bypass: identity-bootstrap — resolves which organization the caller acts in before any organization scope exists.
  return withBypassContext(async () => {
    if (!activeOrgId || activeOrgId === home.orgId) {
      const o = await db.execute<OrgNameSqlRow>(sql`select name from orgs where id = ${home.orgId}`);
      return homeEnvironment(home, o.rows[0]?.name);
    }
    const [row] = await environmentRows(home, sql`o.id = ${activeOrgId}`);
    return row ? admittedEnvironment(home, row) : null;
  });
}
