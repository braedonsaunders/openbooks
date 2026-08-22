import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { getAuthz } from "../../../../lib/authz";
import { RECORD_TYPE_BY_KEY } from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../lib/customization/gates";

export const runtime = "nodejs";

/**
 * PUT /api/customization/form-preferences — set the signed-in user's preferred
 * form for a record type. Self-service (any authenticated user). Body:
 *   { recordType, layoutId?: string | null }
 * layoutId null ⇒ inherit the org default.
 */
export async function PUT(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;
  const body = (await req.json().catch(() => ({}))) as {
    recordType?: string;
    layoutId?: string | null;
  };
  if (!body.recordType || !RECORD_TYPE_BY_KEY[body.recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const refused = await refuseDisabledRecordType(user.orgId, body.recordType);
  if (refused) return refused;
  const layoutId = body.layoutId ?? null;
  if (layoutId) {
    // The preferred form must be one of this org's layouts for this record type.
    const owned = (await db.execute(sql`
      select 1 from form_layouts
       where id = ${layoutId} and org_id = ${user.orgId} and record_type = ${body.recordType}
    `));
    if (!owned.rows[0]) return NextResponse.json({ error: "form layout not found" }, { status: 404 });
  }
  await db.execute(sql`
    insert into user_form_preferences (org_id, user_id, record_type, layout_id, created_by, updated_by)
    values (${user.orgId}, ${user.id}, ${body.recordType}, ${layoutId}, ${user.id}, ${user.id})
    on conflict (org_id, user_id, record_type) do update
      set layout_id = excluded.layout_id, updated_at = now(), updated_by = ${user.id}
    where user_form_preferences.org_id = ${user.orgId}`);
  return NextResponse.json({ ok: true, layoutId });
}
