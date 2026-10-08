import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { currentSession, currentUser } from "./auth";
import { requestAuthzContext } from "./authz-context";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config";
import { canonicalTimeZone } from "@openbooks/engine/src/platform/time-zone.ts";

/**
 * Request-optional active user: outside a request scope (background jobs,
 * scheduled delivery, harness scripts) there is no cookie store, so that one
 * shape resolves to anonymous and callers fall back to neutral defaults.
 * Everything else — DB failures, Next's digested prerender bailouts — still
 * throws, so authenticated resolution and fail-closed behavior are unchanged.
 */
const requestUser = cache(async () => {
  return currentUser().catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'digest' in error) throw error;
    if (error instanceof Error && /outside a request scope/i.test(error.message)) return null;
    throw error;
  });
});

// React's render cache does not memoize route-handler calls. Display facts
// share the native authority frame, which is freshly copied for each read.
const presentationFacts = new WeakMap<object, Map<string, Promise<unknown>>>();
function presentationFact<T>(key: string, load: () => Promise<T>): Promise<T> {
  const verified = requestAuthzContext();
  if (!verified) return load();
  let facts = presentationFacts.get(verified);
  if (!facts) { facts = new Map(); presentationFacts.set(verified, facts); }
  const known = facts.get(key);
  if (known) return known as Promise<T>;
  const pending = load();
  facts.set(key, pending);
  return pending;
}

/**
 * The active locale for this request: the user's personal choice
 * (users.locale) when set, else the tenant default (orgs.settings.defaultLocale),
 * else English. Requests with no authenticated tenant (login page, background
 * agents, harness scripts) use the neutral application default; there is no
 * safe tenant default to read without an organization identity. Cached per
 * request — the i18n request config and the account menu both ask.
 */
async function readLocale(): Promise<Locale> {
  // Off-request requestUser() is null (see above), so this stays anonymous.
  const activeUser = requestAuthzContext()?.user ?? await requestUser();
  if (activeUser) {
    // bypass: user-keyed-lookup — the viewer's own locale preference, read outside the request's organization scope.
    const r = await withBypassContext(async () => (await db.execute(sql`
        select u.locale as user_locale, o.settings ->> 'defaultLocale' as org_default
          from users u
          join orgs o on o.id = u.org_id
         where u.id = ${activeUser.id} and u.org_id = ${activeUser.orgId} and o.id = ${activeUser.orgId} and u.is_active
      `)));
    const row = r.rows[0];
    if (row) {
      if (isLocale(row.user_locale)) return row.user_locale;
      if (isLocale(row.org_default)) return row.org_default;
      return DEFAULT_LOCALE;
    }
  }

  return DEFAULT_LOCALE;
}
const renderLocale = cache(readLocale);
export function resolveLocale(): Promise<Locale> {
  return requestAuthzContext() ? presentationFact("locale", readLocale) : renderLocale();
}

/**
 * The user's stored locale preference (null = inherit the tenant default),
 * for preference UIs that need to distinguish "chose English" from "inherits".
 */
export const userLocalePreference = cache(async (): Promise<Locale | null> => {
  const uid = (await currentSession())?.userId;
  if (!uid) return null;
  // bypass: user-keyed-lookup — the signed-in identity's locale preference, keyed by the session's user id alone.
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
async function readTimeZone(): Promise<string> {
  const activeUser = requestAuthzContext()?.user ?? await requestUser();
  if (!activeUser) return "UTC";
  const r = await withOrgContext(activeUser.orgId, async () => (await db.execute(sql`
      select settings ->> 'timeZone' as time_zone
        from orgs
       where id = ${activeUser.orgId}
    `)));
  const stored = r.rows[0]?.time_zone;
  if (stored == null || String(stored).trim() === "") return "UTC";
  const canonical = canonicalTimeZone(String(stored));
  if (!canonical) {
    throw new Error(`Organization time zone ${JSON.stringify(stored)} is invalid; correct Company Settings → Time zone.`);
  }
  return canonical;
}
const renderTimeZone = cache(readTimeZone);
export function resolveTimeZone(): Promise<string> {
  return requestAuthzContext() ? presentationFact("time-zone", readTimeZone) : renderTimeZone();
}
