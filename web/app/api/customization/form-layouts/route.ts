import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { dbWriteErrorResponse } from "@/lib/api/db-errors";
import { isUuid } from "@/lib/list-params";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission } from "../../../../lib/authz";
import {
  parseFormLayout,
  RECORD_TYPE_BY_KEY,
  type FormLayoutConfig,
} from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../lib/customization/gates";
import { refuseInactiveDefault } from "../../../../lib/customization/active-default";

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
  const r = ((await db.execute(sql`
    select id, record_type as "recordType", name, description, is_default as "isDefault",
           is_active as "isActive", allowed_roles as "allowedRoles", layout
      from form_layouts
     where org_id = ${user.orgId} and record_type = ${recordType}
     order by is_default desc, name
  `)));
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
  // An explicit value outside the boolean domain is refused instead of
  // coercing isDefault with !! or riding isActive into the column (22P02 / silent coerce).
  if (body.isDefault !== undefined && typeof body.isDefault !== "boolean") {
    return NextResponse.json({ error: "isDefault must be a boolean" }, { status: 400 });
  }
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
  }
  // resolveFormLayout calls allowedRoles.some after a length check. A
  // truthy non-array jsonb value has no .some, so resolving any form for
  // that record type throws and every user of that type is formless.
  // Persist only UUID role ids or null; refuse anything else by name.
  if (
    body.allowedRoles !== undefined &&
    body.allowedRoles !== null &&
    (!Array.isArray(body.allowedRoles) ||
      body.allowedRoles.some((r) => typeof r !== "string" || !isUuid(r)))
  ) {
    return NextResponse.json(
      { error: "allowedRoles must be a list of UUID role ids" },
      { status: 400 },
    );
  }
  const isDefault = !!body.isDefault;
  const isActive = body.isActive ?? true;
  // resolveFormLayout only sees is_active rows before picking isDefault.
  // Creating an inactive default clears the prior default and then hides
  // the new one, so forms fall through to the system layout.
  const inactiveDefault = refuseInactiveDefault({ kind: "form", isDefault, isActive });
  if (!inactiveDefault.ok) return NextResponse.json({ error: inactiveDefault.error }, { status: 400 });
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
      if (body.isDefault === true)
        await tx.execute(sql`
          update form_layouts set is_default = false, updated_at = now()
           where org_id = ${user.orgId} and record_type = ${body.recordType} and is_default`);
      const result = (await tx.execute<{ id: string; name: string; snapshot: Record<string, unknown> }>(sql`
        insert into form_layouts (org_id, record_type, name, description, is_default, is_active,
                                  allowed_roles, layout, created_by, updated_by)
        values (${user.orgId}, ${body.recordType}, ${body.name!.trim()}, ${body.description ?? null},
                ${body.isDefault === true}, ${isActive},
                ${body.allowedRoles ? JSON.stringify(body.allowedRoles) : null}, ${layout}, ${user.id}, ${user.id})
        returning id, name, to_jsonb(form_layouts) as snapshot
      `));
      const inserted = result.rows[0]!;
      // Insert evidence follows the {before, after} convention: the created
      // form's full row, so the audit shows what was designed — not just its
      // name. A name alone cannot reconstruct the prior state.
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'form_layouts', ${inserted.id}, 'insert', ${JSON.stringify({ before: null, after: inserted.snapshot })}, ${user.id})`);
      return inserted;
    });
    return NextResponse.json({ id: row.id, name: row.name });
  } catch (e) {
    // Match the (org, record_type, name) unique index by code + constraint
    // name: any driver message mentioning 'unique' is not a name conflict,
    // and the raw driver text must never reach the client.
    return dbWriteErrorResponse(e, {
      route: "customization:form-layouts",
      uniqueConflicts: { form_layouts_org_type_name: "A form with that name already exists" },
    });
  }
}
