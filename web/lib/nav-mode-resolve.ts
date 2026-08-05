import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "@openbooks/engine/src/db.ts";
import { effectiveNavMode, isNavMode, type NavMode } from "./nav-mode";

/**
 * Server-only nav-mode resolution (mirrors web/lib/locale.ts). The pure
 * constants live in nav-mode.ts so client components can import them without
 * pulling in db/auth/cookies.
 *
 * The active nav mode for an authenticated app shell: the user's personal choice
 * (users.nav_mode) when set, else the tenant default
 * (orgs.settings.defaultNavMode), else "topbar".
 *
 * The caller supplies the already-resolved acting user and active organization.
 * This matters in sandbox sessions, where the session cookie identifies the
 * production user while preferences are stored on the active environment's
 * acting user row. The explicit org scope also keeps this query correct under
 * database-enforced tenant isolation.
 */
export async function resolveNavMode(userId: string, orgId: string): Promise<NavMode> {
  return withOrgContext(orgId, async () => {
    const r = (await db.execute(sql`
      select u.nav_mode as user_mode, o.settings ->> 'defaultNavMode' as org_default
        from users u
        join orgs o on o.id = u.org_id
       where u.id = ${userId} and u.org_id = ${orgId} and u.is_active`)) as any;
    const row = r.rows[0];
    return effectiveNavMode(row?.user_mode, row?.org_default);
  });
}

/**
 * The user's stored nav-mode preference (null = inherit the tenant default),
 * for the account-menu selector that distinguishes "chose sidebar" from
 * "inherits".
 */
export async function userNavModePreference(userId: string, orgId: string): Promise<NavMode | null> {
  return withOrgContext(orgId, async () => {
    const r = (await db.execute(sql`
      select nav_mode
        from users
       where id = ${userId} and org_id = ${orgId} and is_active
    `)) as any;
    const value = r.rows[0]?.nav_mode;
    return isNavMode(value) ? value : null;
  });
}
