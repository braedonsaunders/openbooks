import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../../lib/authz";
import { parseFormLayout } from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../../lib/customization/gates";

export const runtime = "nodejs";

async function loadOwn(orgId: string, id: string) {
  const r = (await db.execute(sql`
    select id, record_type as "recordType", name, description, is_default as "isDefault",
           is_active as "isActive", allowed_roles as "allowedRoles", layout
      from form_layouts where org_id = ${orgId} and id = ${id}
  `)) as any;
  return r.rows[0] ?? null;
}

/** GET — one form layout. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  const row = await loadOwn(gate.user.orgId, id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const refused = await refuseDisabledRecordType(gate.user.orgId, row.recordType);
  if (refused) return refused;
  return NextResponse.json(row);
}

/** PATCH — update name/description/layout/allowedRoles/isDefault/isActive. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const { id } = await params;
  const existing = await loadOwn(user.orgId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const refused = await refuseDisabledRecordType(user.orgId, existing.recordType);
  if (refused) return refused;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    name?: string;
    description?: string | null;
    layout?: unknown;
    allowedRoles?: string[] | null;
    isDefault?: boolean;
    isActive?: boolean;
  };
  const sets: ReturnType<typeof sql>[] = [];
  const changes: Record<string, unknown> = {};
  if (body.name !== undefined && body.name.trim()) {
    sets.push(sql`name = ${body.name.trim()}`);
    changes.name = body.name.trim();
  }
  if (body.description !== undefined) {
    sets.push(sql`description = ${body.description}`);
    changes.description = body.description;
  }
  if (body.allowedRoles !== undefined) {
    // JSON.stringify: pg serializes JS arrays as Postgres array literals, which
    // are invalid input for the jsonb column.
    sets.push(sql`allowed_roles = ${body.allowedRoles ? JSON.stringify(body.allowedRoles) : null}`);
    changes.allowedRoles = body.allowedRoles;
  }
  if (body.isActive !== undefined) {
    sets.push(sql`is_active = ${body.isActive}`);
    changes.isActive = body.isActive;
  }
  if (body.layout !== undefined) {
    const parsed = parseFormLayout(body.layout);
    if (!parsed.success)
      return NextResponse.json({ error: "invalid layout", issues: parsed.issues }, { status: 400 });
    if (parsed.data!.recordType !== existing.recordType)
      return NextResponse.json({ error: "layout.recordType does not match this form's record type" }, { status: 400 });
    sets.push(sql`layout = ${parsed.data}`);
    changes.layout = true;
  }
  if (body.isDefault !== undefined) {
    sets.push(sql`is_default = ${body.isDefault}`);
    changes.isDefault = body.isDefault;
  }
  if (sets.length === 0) return NextResponse.json({ ok: true, changed: false });

  try {
    // db.execute goes through the pool (each statement may land on a different
    // connection), so BEGIN/COMMIT must use db.transaction to actually be atomic.
    await db.transaction(async (tx) => {
      if (body.isDefault)
        await tx.execute(sql`
          update form_layouts set is_default = false, updated_at = now()
           where org_id = ${user.orgId} and record_type = ${existing.recordType}
             and is_default and id <> ${id}`);
      await tx.execute(sql`
        update form_layouts set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${user.id}
         where id = ${id} and org_id = ${user.orgId}`);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'form_layouts', ${id}, 'update', ${JSON.stringify(changes)}, ${user.id})`);
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message ?? "update failed";
    if (msg.includes("unique"))
      return NextResponse.json({ error: "A form with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** DELETE — remove a form layout. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const { id } = await params;
  const existing = await loadOwn(user.orgId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const refused = await refuseDisabledRecordType(user.orgId, existing.recordType);
  if (refused) return refused;
  // Delete + audit in one transaction so the two can't diverge (db.execute
  // pools per-statement). audit_log.changes is jsonb NOT NULL, so log the
  // deleted form's name rather than a bare null (which raised a 500).
  const deleted = await db.transaction(async (tx) => {
    const r = ((await tx.execute(sql`
      delete from form_layouts where id = ${id} and org_id = ${user.orgId}
        returning name`)));
    const row = r.rows[0];
    if (!row) return null;
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'form_layouts', ${id}, 'delete', ${JSON.stringify({ name: row.name })}, ${user.id})`);
    return row;
  });
  if (!deleted) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
