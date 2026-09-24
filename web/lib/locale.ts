import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { validateSessionToken, SESSION_COOKIE } from "./auth";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config";
import { canonicalTimeZone } from "@openbooks/engine/src/platform/time-zone.ts";

/**
 * The active locale for this request: the user's personal choice
 * (users.locale) when set, else the tenant default (orgs.settings.defaultLocale),
 * else English. Requests with no authenticated tenant (login page, background
 * agents, harness scripts) use the neutral application default; there is no
 * safe tenant default to read without an organization identity. Cached per
 * request — the i18n request config and the account menu both ask.
 */
export const resolveLocale = cache(async (): Promise<Locale> => {
  // cookies() throws synchronously when there is no request store.
  let jar: Awaited<ReturnType<typeof cookies>> | null = null;
  try {
    jar = await cookies();
  } catch {
    jar = null;
  }
  const uid = jar
    ? (await validateSessionToken(jar.get(SESSION_COOKIE)?.value))?.userId
    : null;

  if (uid) {
    const r = await withBypassContext(async () => (await db.execute(sql`
        select u.locale as user_locale, o.settings ->> 'defaultLocale' as org_default
          from users u
          join orgs o on o.id = u.org_id
         where u.id = ${uid} and u.is_active
      `)));
    const row = r.rows[0];
    if (row) {
      if (isLocale(row.user_locale)) return row.user_locale;
      if (isLocale(row.org_default)) return row.org_default;
      return DEFAULT_LOCALE;
    }
  }

  return DEFAULT_LOCALE;
});

/**
 * The user's stored locale preference (null = inherit the tenant default),
 * for preference UIs that need to distinguish "chose English" from "inherits".
 */
export const userLocalePreference = cache(async (): Promise<Locale | null> => {
  const jar = await cookies();
  const uid = (await validateSessionToken(jar.get(SESSION_COOKIE)?.value))?.userId;
  if (!uid) return null;
  const r = await withBypassContext(async () => (await db.execute(
      sql`select locale from users where id = ${uid} and is_active`,
    )));
  const v = r.rows[0]?.locale;
  return isLocale(v) ? v : null;
});

/**
 * The active organization's configured IANA zone for viewer-facing date and
 * time formatting. This is resolved beside the locale so server rendering
 * and the NextIntl client provider use the same tenant policy. An invalid
 * stored zone is configuration corruption and must be fixed explicitly.
 */
export const resolveTimeZone = cache(async (): Promise<string> => {
  let jar: Awaited<ReturnType<typeof cookies>> | null = null;
  try {
    jar = await cookies();
  } catch {
    jar = null;
  }
  const uid = jar
    ? (await validateSessionToken(jar.get(SESSION_COOKIE)?.value))?.userId
    : null;

  const r = uid
    ? await withBypassContext(async () => (await db.execute(sql`
        select o.settings ->> 'timeZone' as time_zone
          from users u join orgs o on o.id = u.org_id
         where u.id = ${uid} and u.is_active
      `)))
    : await withBypassContext(async () => (await db.execute(sql`
        select settings ->> 'timeZone' as time_zone from orgs limit 1
      `)));
  const stored = r.rows[0]?.time_zone;
  if (stored == null || String(stored).trim() === "") return "UTC";
  const canonical = canonicalTimeZone(String(stored));
  if (!canonical) {
    throw new Error(`Organization time zone ${JSON.stringify(stored)} is invalid; correct Company Settings → Time zone.`);
  }
  return canonical;
});
