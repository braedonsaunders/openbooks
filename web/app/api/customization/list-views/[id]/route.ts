import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { getAuthz, can } from "../../../../../lib/authz";
import { parseListView } from "@openbooks/customization";

export const runtime = "nodejs";

async function loadOwn(orgId: string, userId: string, id: string) {
  const r = (await db.execute(sql`
    select id, record_type as "recordType", name, scope, owner_id as "ownerId",
           is_default as "isDefault", is_active as "isActive", config
      from list_views where org_id = ${orgId} and id = ${id}
  `)) as any;
  const row = r.rows[0] ?? null;
  if (!row) return null;
  // org-scope rows are visible org-wide; user-scope only to the owner.
  if (row.scope === "user" && row.ownerId !== userId) return null;
  return row;
}

/** GET — one saved view (owner or org-shared). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const row = await loadOwn(authz.user.orgId, authz.user.id, id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

/** PATCH — update name/config/isDefault/isActive. Owner or admin only. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;
  const { id } = await params;
  const existing = await loadOwn(user.orgId, user.id, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const adminGated = can(authz, "admin.customization.manage");
  if (existing.scope === "org" && !adminGated)
    return NextResponse.json({ error: "missing permission: admin.customization.manage" }, { status: 403 });
  if (existing.scope === "user" && existing.ownerId !== user.id)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    config?: unknown;
    isDefault?: boolean;
    isActive?: boolean;
  };
  const sets: ReturnType<typeof sql>[] = [];
  const changes: Record<string, unknown> = {};
  if (body.name !== undefined && body.name.trim()) {
    sets.push(sql`name = ${body.name.trim()}`);
    changes.name = body.name.trim();
  }
  if (body.config !== undefined) {
    const parsed = parseListView(body.config);
    if (!parsed.success)
      return NextResponse.json({ error: "invalid view config", issues: parsed.issues }, { status: 400 });
    if (parsed.data!.recordType !== existing.recordType)
      return NextResponse.json({ error: "config.recordType does not match this view's record type" }, { status: 400 });
    sets.push(sql`config = ${parsed.data}`);
    changes.config = true;
  }
  if (body.isDefault !== undefined) {
    sets.push(sql`is_default = ${body.isDefault}`);
    changes.isDefault = body.isDefault;
  }
  if (body.isActive !== undefined) {
    sets.push(sql`is_active = ${body.isActive}`);
    changes.isActive = body.isActive;
  }
  if (sets.length === 0) return NextResponse.json({ ok: true, changed: false });

  try {
    // db.execute goes through the pool (each statement may land on a different
    // connection), so BEGIN/COMMIT must use db.transaction to actually be atomic.
    await db.transaction(async (tx) => {
      if (body.isDefault) {
        if (existing.scope === "org")
          await tx.execute(sql`
            update list_views set is_default = false, updated_at = now()
             where org_id = ${user.orgId} and record_type = ${existing.recordType} and scope='org'
               and is_default and id <> ${id}`);
        else
          await tx.execute(sql`
            update list_views set is_default = false, updated_at = now()
             where org_id = ${user.orgId} and record_type = ${existing.recordType} and scope='user'
               and owner_id = ${user.id} and is_default and id <> ${id}`);
      }
      await tx.execute(sql`
        update list_views set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${user.id}
         where id = ${id} and org_id = ${user.orgId}`);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'list_views', ${id}, 'update', ${JSON.stringify(changes)}, ${user.id})`);
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message ?? "update failed";
    if (msg.includes("unique"))
      return NextResponse.json({ error: "A view with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** DELETE — remove a saved view. Owner or admin only. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;
  const { id } = await params;
  const existing = await loadOwn(user.orgId, user.id, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const adminGated = can(authz, "admin.customization.manage");
  if (existing.scope === "org" && !adminGated)
    return NextResponse.json({ error: "missing permission: admin.customization.manage" }, { status: 403 });
  if (existing.scope === "user" && existing.ownerId !== user.id)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await db.execute(sql`delete from list_views where id = ${id} and org_id = ${user.orgId}`);
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${user.orgId}, 'list_views', ${id}, 'delete', null, ${user.id})`);
  return NextResponse.json({ ok: true });
}
