import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/platform/db";
import { getAuthz } from "../../../lib/authz";
import { isLocale } from "../../../i18n/config";
import { isNavMode } from "../../../lib/nav-mode";
import { preferenceUserIdentity } from "../../../lib/user-preference-identity";

const requestBodySchema = z.object({
  locale: z.string().refine(isLocale, "unsupported locale").nullable().optional(),
  navMode: z.string().refine(isNavMode, "unsupported nav mode").nullable().optional(),
}).refine((body) => body.locale !== undefined || body.navMode !== undefined, "nothing to update");


export const runtime = "nodejs";

/**
 * Self-service profile preferences. PATCH { locale: "fr" | null } and/or
 * { navMode: "topbar" | null } — null clears the personal choice so the user
 * inherits the tenant default (orgs.settings.defaultLocale /
 * orgs.settings.defaultNavMode). Any authenticated user may update their own
 * row; audited like every other mutation.
 */


export const PATCH = defineRoute({
  public: "session",
  body: requestBodySchema,
  handler: async ({ body }) => {

    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { user } = authz;
    const preferenceUser = preferenceUserIdentity(user);




    const hasLocale = "locale" in body;
    const hasNavMode = "navMode" in body;
    if (!hasLocale && !hasNavMode) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    if (hasLocale && body.locale !== null && !isLocale(body.locale)) {
      return NextResponse.json({ error: "unsupported locale" }, { status: 400 });
    }
    if (hasNavMode && body.navMode !== null && !isNavMode(body.navMode)) {
      return NextResponse.json({ error: "unsupported nav mode" }, { status: 400 });
    }

    const sets: SQL[] = [];
    const changes: Record<string, string | null> = {};
    if (hasLocale) {
      const locale = body.locale as string | null;
      sets.push(sql`locale = ${locale}`);
      changes.locale = locale;
    }
    if (hasNavMode) {
      const navMode = body.navMode as string | null;
      sets.push(sql`nav_mode = ${navMode}`);
      changes.navMode = navMode;
    }

    // bypass: identity-bootstrap — a switched production user owns preferences
    // in the home organization while this request is scoped to the active one.
    const updated = await withBypass(async () => {
      const result = await db.execute<{ id: string }>(sql`
        update users set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${user.id}
         where id = ${preferenceUser.id} and org_id = ${preferenceUser.orgId}
         returning id`);
      if (result.rows.length !== 1) return false;
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${preferenceUser.orgId}, 'users', ${preferenceUser.id}, 'update',
                ${JSON.stringify(changes)}, ${user.id})`);
      return true;
    });
    if (!updated) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

    return NextResponse.json({ ok: true, ...changes });
  },
});
