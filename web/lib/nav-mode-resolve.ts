import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { verifySessionToken, SESSION_COOKIE } from "./auth";
import { DEFAULT_NAV_MODE, isNavMode, type NavMode } from "./nav-mode";

/**
 * Server-only nav-mode resolution (mirrors web/lib/locale.ts). The pure
 * constants live in nav-mode.ts so client components can import them without
 * pulling in db/auth/cookies.
 *
 * The active nav mode for this request: the user's personal choice
 * (users.nav_mode) when set, else the tenant default
 * (orgs.settings.defaultNavMode), else "sidebar". Cached per request so the
 * layout and the account menu can both ask without double-querying.
 */
export const resolveNavMode = cache(async (): Promise<NavMode> => {
  const jar = await cookies();
  const uid = verifySessionToken(jar.get(SESSION_COOKIE)?.value);

  if (uid) {
    const r = (await db.execute(sql`
      select u.nav_mode as user_mode, o.settings ->> 'defaultNavMode' as org_default
        from users u
        join orgs o on o.id = u.org_id
       where u.id = ${uid} and u.is_active`)) as any;
    const row = r.rows[0];
    if (row) {
      if (isNavMode(row.user_mode)) return row.user_mode;
      if (isNavMode(row.org_default)) return row.org_default;
      return DEFAULT_NAV_MODE;
    }
  }

  const r = (await db.execute(
    sql`select settings ->> 'defaultNavMode' as org_default from orgs limit 1`,
  )) as any;
  const orgDefault = r.rows[0]?.org_default;
  return isNavMode(orgDefault) ? orgDefault : DEFAULT_NAV_MODE;
});

/**
 * The user's stored nav-mode preference (null = inherit the tenant default),
 * for the account-menu selector that distinguishes "chose sidebar" from
 * "inherits".
 */
export const userNavModePreference = cache(async (): Promise<NavMode | null> => {
  const jar = await cookies();
  const uid = verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!uid) return null;
  const r = (await db.execute(
    sql`select nav_mode from users where id = ${uid} and is_active`,
  )) as any;
  const v = r.rows[0]?.nav_mode;
  return isNavMode(v) ? v : null;
});
