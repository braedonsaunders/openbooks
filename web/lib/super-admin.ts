import "server-only";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import { getAuthz, type Authz } from "./authz";

/** Gate a super-admin surface. Redirects non-super-admins away. */
export async function requireSuperAdmin(): Promise<Authz> {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  if (!authz.user.isSuperAdmin) redirect("/");
  return authz;
}

export interface SuperOrg {
  id: string;
  name: string;
  envKind: string;
  sandboxOf: string | null;
  sandboxCount: number;
  userCount: number;
}
export interface SuperUser {
  id: string;
  email: string;
  name: string;
  orgId: string;
  orgName: string;
  role: string;
  isSuperAdmin: boolean;
}
export interface SuperGrant {
  id: string;
  memberEmail: string;
  memberOrgName: string;
  orgName: string;
  orgId: string;
  actingEmail: string;
}

/** All cross-tenant data for the super console (read under bypass). */
export async function superAdminData(): Promise<{
  orgs: SuperOrg[];
  users: SuperUser[];
  grants: SuperGrant[];
}> {
  return withBypassContext(async () => {
    const orgs = (await db.execute(sql`
      select o.id, o.name, o.env_kind as "envKind", o.sandbox_of as "sandboxOf",
             (select count(*) from sandboxes s where s.production_org_id = o.id)::int as "sandboxCount",
             (select count(*) from users u where u.org_id = o.id)::int as "userCount"
        from orgs o
       order by o.env_kind, o.name`)) as any;
    const users = (await db.execute(sql`
      select u.id, u.email, u.name, u.org_id as "orgId", o.name as "orgName", u.role,
             u.is_super_admin as "isSuperAdmin"
        from users u join orgs o on o.id = u.org_id
       where o.env_kind = 'production'
       order by o.name, u.email`)) as any;
    const grants = (await db.execute(sql`
      select a.id, m.email as "memberEmail", mo.name as "memberOrgName",
             o.name as "orgName", a.org_id as "orgId", au.email as "actingEmail"
        from user_org_access a
        join users m on m.id = a.member_user_id
        join orgs mo on mo.id = m.org_id
        join orgs o on o.id = a.org_id
        join users au on au.id = a.acting_user_id
       where a.is_active
       order by m.email, o.name`)) as any;
    return { orgs: orgs.rows, users: users.rows, grants: grants.rows };
  });
}
