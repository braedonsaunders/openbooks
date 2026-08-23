import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { getAuthz } from "../../../../lib/authz";
import { RECORD_TYPE_BY_KEY } from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../lib/customization/gates";

export const runtime = "nodejs";

/**
 * PUT /api/customization/list-preferences — set the signed-in user's default
 * saved list view for a record type. Self-service. Body:
 *   { recordType, viewId?: string | null }
 */
export async function PUT(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    recordType?: string;
    viewId?: string | null;
  };
  if (!body.recordType || !RECORD_TYPE_BY_KEY[body.recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const refused = await refuseDisabledRecordType(user.orgId, body.recordType);
  if (refused) return refused;
  const viewId = body.viewId ?? null;
  if (viewId) {
    // Must be a view this user can actually use: in-org, right record type,
    // and either org-shared or their own personal view.
    const owned = (await db.execute(sql`
      select 1 from list_views
       where id = ${viewId} and org_id = ${user.orgId} and record_type = ${body.recordType}
         and (scope = 'org' or owner_id = ${user.id})
    `));
    if (!owned.rows[0]) return NextResponse.json({ error: "list view not found" }, { status: 404 });
  }
  await db.execute(sql`
    insert into user_list_preferences (org_id, user_id, record_type, view_id, created_by, updated_by)
    values (${user.orgId}, ${user.id}, ${body.recordType}, ${viewId}, ${user.id}, ${user.id})
    on conflict (org_id, user_id, record_type) do update
      set view_id = excluded.view_id, updated_at = now(), updated_by = ${user.id}
    where user_list_preferences.org_id = ${user.orgId}`);
  return NextResponse.json({ ok: true, viewId });
}
