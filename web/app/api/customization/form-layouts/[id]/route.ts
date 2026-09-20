import { parseJsonBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission } from "../../../../../lib/authz";
import { parseFormLayout } from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../../lib/customization/gates";
import { inactiveDefaultMessage, nextDefaultFlags, refuseInactiveDefault } from "../../../../../lib/customization/active-default";

export const runtime = "nodejs";

const nameBodySchema = z.looseObject({
  name: z.string().optional(),
});

async function loadOwn(orgId: string, id: string) {
  if (!isUuid(id)) return null;
  const r = (await db.execute<{ id: string; recordType: string; name: string; description: string | null; isDefault: boolean; isActive: boolean; allowedRoles: unknown; layout: unknown }>(sql`
    select id, record_type as "recordType", name, description, is_default as "isDefault",
           is_active as "isActive", allowed_roles as "allowedRoles", layout
      from form_layouts where org_id = ${orgId} and id = ${id}
  `));
  return r.rows[0] ?? null;
}

/** GET — one form layout. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a UUID" }, { status: 400 });
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
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a UUID" }, { status: 400 });
  const existing = await loadOwn(user.orgId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const refused = await refuseDisabledRecordType(user.orgId, existing.recordType);
  if (refused) return refused;
  const parsedBody = await parseJsonBody(req, nameBodySchema);
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
  if (body.name !== undefined && typeof body.name !== "string") {
    return NextResponse.json({ error: "name must be a string" }, { status: 400 });
  }
  // A supplied name is an explicit write. Collection POST already refuses
  // !body.name?.trim(); dropping whitespace here would report
  // {ok:true, changed:false} (or apply sibling fields) as if the operator
  // asked for a no-op. Refuse by name instead.
  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
  }
  if (body.name !== undefined) {
    const name = body.name.trim();
    sets.push(sql`name = ${name}`);
    changes.name = name;
  }
  if (body.description !== undefined) {
    sets.push(sql`description = ${body.description}`);
    changes.description = body.description;
  }
  if (body.allowedRoles !== undefined) {
    // resolveFormLayout calls allowedRoles.some after a length check. A
    // truthy non-array jsonb value (object, number, or string) has no
    // .some, so resolving any form for that record type throws and every
    // user of that type is formless. Persist only UUID role ids or null.
    if (
      body.allowedRoles !== null &&
      (!Array.isArray(body.allowedRoles) ||
        body.allowedRoles.some((r) => typeof r !== "string" || !isUuid(r)))
    ) {
      return NextResponse.json(
        { error: "allowedRoles must be a list of UUID role ids" },
        { status: 400 },
      );
    }
    // JSON.stringify: pg serializes JS arrays as Postgres array literals, which
    // are invalid input for the jsonb column.
    sets.push(sql`allowed_roles = ${body.allowedRoles ? JSON.stringify(body.allowedRoles) : null}`);
    changes.allowedRoles = body.allowedRoles;
  }
  if (body.isActive !== undefined) {
    // Collection POST refuses a non-boolean isDefault. An explicit PATCH
    // isActive outside the boolean domain would otherwise reach the column
    // and either coerce silently or abort with an unhandled storage 500.
    if (typeof body.isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
    }
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
    if (typeof body.isDefault !== "boolean") {
      return NextResponse.json({ error: "isDefault must be a boolean" }, { status: 400 });
    }
    sets.push(sql`is_default = ${body.isDefault}`);
    changes.isDefault = body.isDefault;
  }
  // Request-complete contradiction needs no row snapshot. Concurrent
  // default+deactivate is decided from the locked row inside the write.
  const requestFlags = nextDefaultFlags(existing, { isDefault: body.isDefault, isActive: body.isActive });
  const requestRefusal = refuseInactiveDefault({ kind: "form", ...requestFlags });
  if (!requestRefusal.ok) return NextResponse.json({ error: requestRefusal.error }, { status: 400 });
  if (sets.length === 0) return NextResponse.json({ ok: true, changed: false });

  const nextDefaultSql = body.isDefault !== undefined ? sql`${body.isDefault}` : sql`is_default`;
  const nextActiveSql = body.isActive !== undefined ? sql`${body.isActive}` : sql`is_active`;

  try {
    // db.execute goes through the pool (each statement may land on a different
    // connection), so BEGIN/COMMIT must use db.transaction to actually be atomic.
    const updated = await db.transaction(async (tx) => {
      const locked = (await tx.execute<{
        id: string;
        recordType: string;
        isDefault: boolean;
        isActive: boolean;
      }>(sql`
        select id, record_type as "recordType",
               is_default as "isDefault", is_active as "isActive"
          from form_layouts
         where id = ${id} and org_id = ${user.orgId}
         for update`)).rows[0];
      if (!locked) return { kind: "not_found" as const };
      const nextFlags = nextDefaultFlags(locked, { isDefault: body.isDefault, isActive: body.isActive });
      const inactiveDefault = refuseInactiveDefault({ kind: "form", ...nextFlags });
      if (!inactiveDefault.ok) return { kind: "inactive_default" as const, error: inactiveDefault.error };
      if (body.isDefault)
        await tx.execute(sql`
          update form_layouts set is_default = false, updated_at = now()
           where org_id = ${user.orgId} and record_type = ${locked.recordType}
             and is_default and id <> ${id}`);
      // Next-state default+inactive must match zero rows even if the JS
      // refusal is skipped — refuse by name, never {ok:true}.
      const written = (await tx.execute<{ id: string }>(sql`
        update form_layouts set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${user.id}
         where id = ${id} and org_id = ${user.orgId}
           and not (${nextDefaultSql} and not ${nextActiveSql})
         returning id`)).rows[0];
      if (!written) {
        return { kind: "inactive_default" as const, error: inactiveDefaultMessage("form") };
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'form_layouts', ${id}, 'update', ${JSON.stringify(changes)}, ${user.id})`);
      return { kind: "ok" as const };
    });
    if (updated.kind === "not_found") return NextResponse.json({ error: "not found" }, { status: 404 });
    if (updated.kind === "inactive_default") return NextResponse.json({ error: updated.error }, { status: 400 });
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
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a UUID" }, { status: 400 });
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
