import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/platform/db";
import { effectiveNavMode, isNavMode, type NavMode } from "./nav-mode";
import { preferenceUserIdentity, type PreferenceUser } from "./user-preference-identity";

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
export async function resolveNavMode(user: PreferenceUser): Promise<NavMode> {
  const row = await navModeSettings(user);
  return effectiveNavMode(row?.user_mode, row?.org_default);
}

/**
 * The user's stored nav-mode preference (null = inherit the tenant default),
 * for the account-menu selector that distinguishes "chose sidebar" from
 * "inherits".
 */
export async function userNavModePreference(user: PreferenceUser): Promise<NavMode | null> {
  const value = (await navModeSettings(user))?.user_mode;
  return isNavMode(value) ? value : null;
}

// The shell asks for the effective mode and the stored preference in one
// render; both read the same row once.
const navModeSettings = cache(async (user: PreferenceUser) => {
  const preferenceUser = preferenceUserIdentity(user);
  // bypass: user-keyed-lookup — read the personal preference and active
  // organization's default with explicit identities across tenant scope.
  const r = await withBypassContext(() =>
    db.execute<{ user_mode: unknown; org_default: unknown }>(
      sql`
      select u.nav_mode as user_mode, o.settings ->> 'defaultNavMode' as org_default
        from users u
        left join orgs o on o.id = ${user.orgId}
       where u.id = ${preferenceUser.id} and u.org_id = ${preferenceUser.orgId} and u.is_active`,
      "objects",
    ),
  );
  return r[0];
});
