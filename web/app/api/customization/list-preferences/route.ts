import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { getAuthz } from "../../../../lib/authz";
import { RECORD_TYPE_BY_KEY } from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../lib/customization/gates";
import { isUuid } from "../../../../lib/list-params";

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
  // A malformed id would surface as a Postgres uuid throw and a raw 500;
  // resolve it through the same 404 as an unknown view.
  if (viewId && !isUuid(viewId)) {
    return NextResponse.json({ error: "list view not found" }, { status: 404 });
  }
  // db.execute goes through the pool (each statement may land on a different
  // connection), so BEGIN/COMMIT must use db.transaction to actually be atomic.
  // FOR UPDATE holds the list_views row until the preference write commits, so
  // a concurrent deactivation cannot slip between the active-state read and
  // the upsert. resolveListView only loads is_active rows; a split read/write
  // would report {ok} for a view resolution cannot apply.
  const outcome = await db.transaction(async (tx) => {
    if (viewId) {
      const owned = (await tx.execute<{ isActive: boolean; name: string }>(sql`
        select is_active as "isActive", name from list_views
         where id = ${viewId} and org_id = ${user.orgId} and record_type = ${body.recordType}
           and (scope = 'org' or owner_id = ${user.id})
         for update
      `));
      if (!owned.rows[0]) return { kind: "missing" as const };
      if (!owned.rows[0].isActive) {
        return { kind: "inactive" as const, name: owned.rows[0].name };
      }
    }
    const written = await tx.execute(sql`
      insert into user_list_preferences (org_id, user_id, record_type, view_id, created_by, updated_by)
      values (${user.orgId}, ${user.id}, ${body.recordType}, ${viewId}, ${user.id}, ${user.id})
      on conflict (org_id, user_id, record_type) do update
        set view_id = excluded.view_id, updated_at = now(), updated_by = ${user.id}
      where user_list_preferences.org_id = ${user.orgId}`);
    if ((written.rowCount ?? 0) !== 1) return { kind: "unwritten" as const };
    return { kind: "ok" as const };
  });
  if (outcome.kind === "missing") return NextResponse.json({ error: "list view not found" }, { status: 404 });
  if (outcome.kind === "inactive") {
    return NextResponse.json({
      error: `list view "${outcome.name}" is inactive — reactivate it or choose an active view`,
    }, { status: 422 });
  }
  if (outcome.kind === "unwritten") {
    return NextResponse.json({
      error: "list preference was not saved — retry after confirming the view is still active",
    }, { status: 409 });
  }
  return NextResponse.json({ ok: true, viewId });
}
