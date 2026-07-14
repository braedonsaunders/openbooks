import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { verifySessionToken, SESSION_COOKIE } from "./auth";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config";

/**
 * The active locale for this request: the user's personal choice
 * (users.locale) when set, else the tenant default (orgs.settings.defaultLocale),
 * else English. Unauthenticated requests (login page) get the tenant default
 * of the install's org. Cached per request — the i18n request config and the
 * account menu both ask.
 */
export const resolveLocale = cache(async (): Promise<Locale> => {
  const jar = await cookies();
  const uid = verifySessionToken(jar.get(SESSION_COOKIE)?.value);

  if (uid) {
    const r = (await db.execute(sql`
      select u.locale as user_locale, o.settings ->> 'defaultLocale' as org_default
        from users u
        join orgs o on o.id = u.org_id
       where u.id = ${uid} and u.is_active`)) as any;
    const row = r.rows[0];
    if (row) {
      if (isLocale(row.user_locale)) return row.user_locale;
      if (isLocale(row.org_default)) return row.org_default;
      return DEFAULT_LOCALE;
    }
  }

  const r = (await db.execute(
    sql`select settings ->> 'defaultLocale' as org_default from orgs limit 1`,
  )) as any;
  const orgDefault = r.rows[0]?.org_default;
  return isLocale(orgDefault) ? orgDefault : DEFAULT_LOCALE;
});

/**
 * The user's stored locale preference (null = inherit the tenant default),
 * for preference UIs that need to distinguish "chose English" from "inherits".
 */
export const userLocalePreference = cache(async (): Promise<Locale | null> => {
  const jar = await cookies();
  const uid = verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!uid) return null;
  const r = (await db.execute(
    sql`select locale from users where id = ${uid} and is_active`,
  )) as any;
  const v = r.rows[0]?.locale;
  return isLocale(v) ? v : null;
});
