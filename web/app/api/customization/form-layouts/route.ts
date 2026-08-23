import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../lib/authz";
import {
  parseFormLayout,
  RECORD_TYPE_BY_KEY,
  type FormLayoutConfig,
} from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../lib/customization/gates";

export const runtime = "nodejs";

/** GET /api/customization/form-layouts?recordType=vendor_bill — list org forms. */
export async function GET(req: Request) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const recordType = new URL(req.url).searchParams.get("recordType") ?? "";
  if (!RECORD_TYPE_BY_KEY[recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const refused = await refuseDisabledRecordType(user.orgId, recordType);
  if (refused) return refused;
  const r = (await db.execute(sql`
    select id, record_type as "recordType", name, description, is_default as "isDefault",
           is_active as "isActive", allowed_roles as "allowedRoles", layout
      from form_layouts
     where org_id = ${user.orgId} and record_type = ${recordType}
     order by is_default desc, name
  `)) as any;
  return NextResponse.json({ rows: r.rows });
}

/** POST — create a custom form. Body: { recordType, name, description?, layout, allowedRoles?, isDefault?, isActive? } */
export async function POST(req: Request) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    recordType?: string;
    name?: string;
    description?: string | null;
    layout?: unknown;
    allowedRoles?: string[] | null;
    isDefault?: boolean;
    isActive?: boolean;
  };
  if (!body.recordType || !RECORD_TYPE_BY_KEY[body.recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const refused = await refuseDisabledRecordType(user.orgId, body.recordType);
  if (refused) return refused;
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const parsed = parseFormLayout(body.layout ?? { schemaVersion: 1, recordType: body.recordType });
  if (!parsed.success)
    return NextResponse.json({ error: "invalid layout", issues: parsed.issues }, { status: 400 });
  const layout = parsed.data as FormLayoutConfig;
  if (layout.recordType !== body.recordType)
    return NextResponse.json({ error: "layout.recordType does not match recordType" }, { status: 400 });

  try {
    // db.execute goes through the pool (each statement may land on a different
    // connection), so BEGIN/COMMIT must use db.transaction to actually be atomic.
    const row = await db.transaction(async (tx) => {
      if (body.isDefault)
        await tx.execute(sql`
          update form_layouts set is_default = false, updated_at = now()
           where org_id = ${user.orgId} and record_type = ${body.recordType} and is_default`);
      const result = (await tx.execute(sql`
        insert into form_layouts (org_id, record_type, name, description, is_default, is_active,
                                  allowed_roles, layout, created_by, updated_by)
        values (${user.orgId}, ${body.recordType}, ${body.name!.trim()}, ${body.description ?? null},
                ${!!body.isDefault}, ${body.isActive ?? true},
                ${body.allowedRoles ? JSON.stringify(body.allowedRoles) : null}, ${layout}, ${user.id}, ${user.id})
        returning id, name
      `)) as any;
      const inserted = result.rows[0];
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'form_layouts', ${inserted.id}, 'insert', ${JSON.stringify({ name: body.name })}, ${user.id})`);
      return inserted;
    });
    return NextResponse.json({ id: row.id, name: row.name });
  } catch (e) {
    const msg = (e as Error).message ?? "insert failed";
    if (msg.includes("unique"))
      return NextResponse.json({ error: "A form with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
