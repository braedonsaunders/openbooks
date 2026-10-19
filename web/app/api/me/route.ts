import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { getAuthz } from "../../../lib/authz";
import { isLocale } from "../../../i18n/config";
import { isNavMode } from "../../../lib/nav-mode";

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

    // The preference belongs to the identity the request acts as; a write
    // that reaches no row saved nothing, so it is refused, not reported saved.
    const saved = await db.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        update users set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${user.id}
         where id = ${user.id} and org_id = ${user.orgId} and is_active`);
      if (updated.rowCount !== 1) return false;
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'users', ${user.id}, 'update',
                ${JSON.stringify(changes)}, ${user.id})`);
      return true;
    });
    if (!saved) {
      return NextResponse.json(
        { error: "Your account is not active in this workspace, so the preference was not saved.", remedy: "Sign in again, then choose the preference." },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, ...changes });
  },
});
