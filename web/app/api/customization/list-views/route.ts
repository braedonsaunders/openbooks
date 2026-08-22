import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { getAuthz, can } from "../../../../lib/authz";
import { parseListView, RECORD_TYPE_BY_KEY, type ListViewConfig } from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../lib/customization/gates";

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
  const r = (await db.execute(sql`
    select id, record_type as "recordType", name, scope, owner_id as "ownerId",
           is_default as "isDefault", is_active as "isActive", config
      from list_views
     where org_id = ${user.orgId} and record_type = ${recordType} and is_active
       and (scope = 'org' or owner_id = ${user.id})
     order by scope asc, is_default desc, name
  `)) as any;
  return NextResponse.json({ rows: r.rows });
}

/** POST — create a saved view. Body: { recordType, name, scope:'org'|'user', config, isDefault? } */
export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;
  const body = (await req.json().catch(() => ({}))) as {
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
  const config = parsed.data as ListViewConfig;
  if (config.recordType !== body.recordType)
    return NextResponse.json({ error: "config.recordType does not match recordType" }, { status: 400 });
  const ownerId = scope === "user" ? user.id : null;

  try {
    // db.execute goes through the pool (each statement may land on a different
    // connection), so BEGIN/COMMIT must use db.transaction to actually be atomic.
    const row = await db.transaction(async (tx) => {
      if (body.isDefault) {
        if (scope === "org")
          await tx.execute(sql`
            update list_views set is_default = false, updated_at = now()
             where org_id = ${user.orgId} and record_type = ${body.recordType} and scope='org' and is_default`);
        else
          await tx.execute(sql`
            update list_views set is_default = false, updated_at = now()
             where org_id = ${user.orgId} and record_type = ${body.recordType} and scope='user'
               and owner_id = ${user.id} and is_default`);
      }
      const [inserted] = (await tx.execute(sql`
        insert into list_views (org_id, record_type, name, scope, owner_id, is_default, is_active,
                                config, created_by, updated_by)
        values (${user.orgId}, ${body.recordType}, ${body.name!.trim()}, ${scope}, ${ownerId},
                ${!!body.isDefault}, true, ${config}, ${user.id}, ${user.id})
        returning id, name`) as any).rows;
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'list_views', ${inserted.id}, 'insert', ${JSON.stringify({ name: body.name, scope })}, ${user.id})`);
      return inserted;
    });
    return NextResponse.json({ id: row.id, name: row.name });
  } catch (e) {
    const msg = (e as Error).message ?? "insert failed";
    if (msg.includes("unique"))
      return NextResponse.json({ error: "A view with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
