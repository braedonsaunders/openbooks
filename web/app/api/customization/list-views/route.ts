import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { getAuthz, can } from "../../../../lib/authz";
import { parseListView, RECORD_TYPE_BY_KEY, stripSeededDefaultMark, type ListViewConfig } from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../lib/customization/gates";
import {
  AmbiguousListViewDefaultError,
  assertSingleListViewDefault,
  claimListViewDefaultSlot,
} from "../../../../lib/customization/list-view-default";

export const runtime = "nodejs";

/** GET /api/customization/list-views?recordType=vendor_bill — saved views for the user. */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;
  const recordType = new URL(req.url).searchParams.get("recordType") ?? "";
  if (!RECORD_TYPE_BY_KEY[recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const refused = await refuseDisabledRecordType(user.orgId, recordType);
  if (refused) return refused;
  const r = ((await db.execute(sql`
    select id, record_type as "recordType", name, scope, owner_id as "ownerId",
           is_default as "isDefault", is_active as "isActive", config
      from list_views
     where org_id = ${user.orgId} and record_type = ${recordType} and is_active
       and (scope = 'org' or owner_id = ${user.id})
     order by scope asc, is_default desc, name
  `)));
  return NextResponse.json({ rows: r.rows });
}

/** POST — create a saved view. Body: { recordType, name, scope:'org'|'user', config, isDefault? } */
export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    recordType?: string;
    name?: string;
    scope?: string;
    config?: unknown;
    isDefault?: boolean;
  };
  if (!body.recordType || !RECORD_TYPE_BY_KEY[body.recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const refused = await refuseDisabledRecordType(user.orgId, body.recordType);
  if (refused) return refused;
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const scope = body.scope === "org" ? "org" : "user";
  // org-scope views require the admin permission; personal views are self-service.
  if (scope === "org" && !can(authz, "admin.customization.manage"))
    return NextResponse.json({ error: "missing permission: admin.customization.manage" }, { status: 403 });
  const parsed = parseListView(body.config ?? { schemaVersion: 1, recordType: body.recordType });
  if (!parsed.success)
    return NextResponse.json({ error: "invalid view config", issues: parsed.issues }, { status: 400 });
  // The seed mark must never be (re)stored through the designer: strip it
  // explicitly here rather than relying on the parser dropping unknown keys,
  // so a future parser change cannot resurrect frozen snapshots as untouched.
  const config = stripSeededDefaultMark(parsed.data as ListViewConfig);
  if (config.recordType !== body.recordType)
    return NextResponse.json({ error: "config.recordType does not match recordType" }, { status: 400 });
  const ownerId = scope === "user" ? user.id : null;

  try {
    // db.execute goes through the pool (each statement may land on a different
    // connection), so BEGIN/COMMIT must use db.transaction to actually be atomic.
    const row = await db.transaction(async (tx) => {
      const defaultScope = { orgId: user.orgId, recordType: body.recordType!, scope, ownerId };
      if (body.isDefault) await claimListViewDefaultSlot(tx, defaultScope);
      const inserted = (await tx.execute<{ id: string; name: string }>(sql`
        insert into list_views (org_id, record_type, name, scope, owner_id, is_default, is_active,
                                config, created_by, updated_by)
        values (${user.orgId}, ${body.recordType}, ${body.name!.trim()}, ${scope}, ${ownerId},
                ${!!body.isDefault}, true, ${config}, ${user.id}, ${user.id})
        returning id, name`)).rows[0]!;
      if (body.isDefault) await assertSingleListViewDefault(tx, defaultScope);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'list_views', ${inserted.id}, 'insert', ${JSON.stringify({ name: body.name, scope })}, ${user.id})`);
      return inserted;
    });
    return NextResponse.json({ id: row.id, name: row.name });
  } catch (e) {
    const msg = (e as Error).message ?? "insert failed";
    if (e instanceof AmbiguousListViewDefaultError)
      return NextResponse.json({ error: e.message }, { status: 409 });
    if (msg.includes("unique"))
      return NextResponse.json({ error: "A view with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
