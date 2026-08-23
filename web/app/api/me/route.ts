import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { getAuthz } from "../../../lib/authz";
import { isLocale } from "../../../i18n/config";
import { isNavMode } from "../../../lib/nav-mode";

export const runtime = "nodejs";

/**
 * Self-service profile preferences. PATCH { locale: "fr" | null } and/or
 * { navMode: "topbar" | null } — null clears the personal choice so the user
 * inherits the tenant default (orgs.settings.defaultLocale /
 * orgs.settings.defaultNavMode). Any authenticated user may update their own
 * row; audited like every other mutation.
 */
export async function PATCH(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    locale?: unknown;
    navMode?: unknown;
  };
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

  const sets = [];
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

  await db.execute(sql`
    update users set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${user.id}
     where id = ${user.id} and org_id = ${user.orgId}`);
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${user.orgId}, 'users', ${user.id}, 'update',
            ${JSON.stringify(changes)}, ${user.id})`);

  return NextResponse.json({ ok: true, ...changes });
}
