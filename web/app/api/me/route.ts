import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { getAuthz } from "../../../lib/authz";
import { isLocale } from "../../../i18n/config";

export const runtime = "nodejs";

/**
 * Self-service profile preferences. PATCH { locale: "fr" | null } — null
 * clears the personal choice so the user inherits the tenant default
 * (orgs.settings.defaultLocale). Any authenticated user may update their own
 * row; audited like every other mutation.
 */
export async function PATCH(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;

  const body = (await req.json().catch(() => ({}))) as { locale?: unknown };
  if (!("locale" in body)) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  if (body.locale !== null && !isLocale(body.locale)) {
    return NextResponse.json({ error: "unsupported locale" }, { status: 400 });
  }
  const locale = body.locale as string | null;

  await db.execute(sql`
    update users set locale = ${locale}, updated_at = now(), updated_by = ${user.id}
     where id = ${user.id}`);
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${user.orgId}, 'users', ${user.id}, 'update',
            ${JSON.stringify({ locale })}, ${user.id})`);

  return NextResponse.json({ ok: true, locale });
}
