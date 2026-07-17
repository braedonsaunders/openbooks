import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { seedDashboardDefaultsForOrg } from "@openbooks/engine/src/dashboard-defaults.ts";
import type { SubsidiaryRestriction } from "@openbooks/schema";
import { guardPermission } from "../../../../lib/authz";
import { isCataloguePermission, PERMISSION_CATALOGUE } from "../../../../lib/permissions";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Admin role management: create custom roles, edit a role's permissions,
 * delete custom roles. Gated by admin.roles.manage; org-scoped and audited.
 *
 * Built-in roles: only `permissions` may change, and the `admin` role is
 * fully locked (always the full catalogue) so an org can't lock itself out.
 */

const KEY_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/** Validate + normalize a permissions payload to deduped catalogue keys in catalogue order. */
function normalizePermissions(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const set = new Set<string>();
  for (const p of input) {
    if (typeof p !== "string" || !isCataloguePermission(p)) return null;
    set.add(p);
  }
  return PERMISSION_CATALOGUE.filter((p) => set.has(p));
}

/**
 * Strictly shape-check a subsidiaryRestriction payload against the union
 * ({mode:'all'} | {mode:'subtree', subsidiaryId} | {mode:'list', subsidiaryIds})
 * and verify every referenced subsidiary exists in the org. Returns the
 * normalized value or an error string.
 */
async function normalizeSubsidiaryRestriction(
  input: unknown,
  orgId: string,
): Promise<{ value: SubsidiaryRestriction } | { error: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "subsidiaryRestriction must be an object" };
  }
  const { mode } = input as { mode?: unknown };
  if (mode === "all") return { value: { mode: "all" } };

  const checkExist = async (ids: string[]): Promise<string | null> => {
    const found = (await db.execute(sql`
      select id from subsidiaries
       where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`)) as any;
    const known = new Set(found.rows.map((r: any) => r.id as string));
    const missing = ids.find((id) => !known.has(id));
    return missing ? `unknown subsidiary: ${missing}` : null;
  };

  if (mode === "subtree") {
    const { subsidiaryId } = input as { subsidiaryId?: unknown };
    if (typeof subsidiaryId !== "string" || !isUuid(subsidiaryId)) {
      return { error: "subsidiaryRestriction.subsidiaryId must be a uuid" };
    }
    const missing = await checkExist([subsidiaryId]);
    if (missing) return { error: missing };
    return { value: { mode: "subtree", subsidiaryId } };
  }
  if (mode === "list") {
    const { subsidiaryIds } = input as { subsidiaryIds?: unknown };
    if (
      !Array.isArray(subsidiaryIds) ||
      subsidiaryIds.length === 0 ||
      !subsidiaryIds.every((id): id is string => typeof id === "string" && isUuid(id))
    ) {
      return { error: "subsidiaryRestriction.subsidiaryIds must be a non-empty array of uuids" };
    }
    const ids = [...new Set(subsidiaryIds)];
    const missing = await checkExist(ids);
    if (missing) return { error: missing };
    return { value: { mode: "list", subsidiaryIds: ids } };
  }
  return { error: "subsidiaryRestriction.mode must be all, subtree, or list" };
}

async function audit(args: {
  orgId: string;
  rowId: string;
  action: "insert" | "update" | "delete";
  changes: Record<string, unknown>;
  actorId: string;
}) {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'app_roles', ${args.rowId}, ${args.action},
            ${JSON.stringify(args.changes)}, ${args.actorId})`);
}

export async function POST(req: Request) {
  const gate = await guardPermission("admin.roles.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const body = (await req.json()) as {
    name?: string;
    key?: string;
    description?: string;
    permissions?: unknown;
    subsidiaryRestriction?: unknown;
  };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const key = (body.key?.trim() || slugify(name)).toLowerCase();
  if (!KEY_RE.test(key)) {
    return NextResponse.json(
      { error: "key must be 2–64 chars: lowercase letters, digits, _ or -" },
      { status: 400 },
    );
  }
  const permissions = normalizePermissions(body.permissions ?? []);
  if (!permissions) {
    return NextResponse.json({ error: "permissions must be known catalogue keys" }, { status: 400 });
  }
  let restriction: SubsidiaryRestriction = { mode: "all" };
  if (body.subsidiaryRestriction !== undefined) {
    const norm = await normalizeSubsidiaryRestriction(body.subsidiaryRestriction, actor.orgId);
    if ("error" in norm) return NextResponse.json({ error: norm.error }, { status: 400 });
    restriction = norm.value;
  }

  const inserted = (await db.execute(sql`
    insert into app_roles (org_id, key, name, description, is_built_in, permissions,
                           subsidiary_restriction, created_by, updated_by)
    values (${actor.orgId}, ${key}, ${name}, ${body.description?.trim() || null}, false,
            ${JSON.stringify(permissions)}, ${JSON.stringify(restriction)}, ${actor.id}, ${actor.id})
    on conflict (org_id, key) do nothing
    returning id`)) as any;
  if (!inserted.rows[0]) {
    return NextResponse.json({ error: `a role with key "${key}" already exists` }, { status: 409 });
  }
  await seedDashboardDefaultsForOrg(actor.orgId, [key]);
  await audit({
    orgId: actor.orgId,
    rowId: inserted.rows[0].id,
    action: "insert",
    changes: {
      key: [null, key],
      name: [null, name],
      permissions: [null, permissions],
      subsidiaryRestriction: [null, restriction],
    },
    actorId: actor.id,
  });
  return NextResponse.json({ ok: true, id: inserted.rows[0].id });
}

export async function PATCH(req: Request) {
  const gate = await guardPermission("admin.roles.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const body = (await req.json()) as {
    id?: string;
    name?: string;
    description?: string;
    permissions?: unknown;
    subsidiaryRestriction?: unknown;
  };
  if (!body.id || !isUuid(body.id)) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const existing = (await db.execute(sql`
    select id, key, name, description, is_built_in, permissions, subsidiary_restriction
      from app_roles where id = ${body.id} and org_id = ${actor.orgId}`)) as any;
  const role = existing.rows[0];
  if (!role) return NextResponse.json({ error: "role not found" }, { status: 404 });
  if (role.is_built_in && role.key === "admin") {
    return NextResponse.json({ error: "the Administrator role cannot be edited" }, { status: 403 });
  }

  const changes: Record<string, unknown> = {};
  const sets: SQL[] = [];

  if (body.permissions !== undefined) {
    const permissions = normalizePermissions(body.permissions);
    if (!permissions) {
      return NextResponse.json(
        { error: "permissions must be known catalogue keys" },
        { status: 400 },
      );
    }
    sets.push(sql`permissions = ${JSON.stringify(permissions)}`);
    changes.permissions = [role.permissions, permissions];
  }
  // Like permissions, subsidiary access may change on built-in roles too.
  if (body.subsidiaryRestriction !== undefined) {
    const norm = await normalizeSubsidiaryRestriction(body.subsidiaryRestriction, actor.orgId);
    if ("error" in norm) return NextResponse.json({ error: norm.error }, { status: 400 });
    sets.push(sql`subsidiary_restriction = ${JSON.stringify(norm.value)}`);
    changes.subsidiaryRestriction = [role.subsidiary_restriction, norm.value];
  }
  if (body.name !== undefined || body.description !== undefined) {
    if (role.is_built_in) {
      return NextResponse.json(
        { error: "only permissions can be changed on a built-in role" },
        { status: 400 },
      );
    }
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      sets.push(sql`name = ${name}`);
      changes.name = [role.name, name];
    }
    if (body.description !== undefined) {
      const description = body.description.trim() || null;
      sets.push(sql`description = ${description}`);
      changes.description = [role.description, description];
    }
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  await db.execute(sql`
    update app_roles
       set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${actor.id}
     where id = ${body.id} and org_id = ${actor.orgId}`);
  await audit({ orgId: actor.orgId, rowId: body.id, action: "update", changes, actorId: actor.id });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const gate = await guardPermission("admin.roles.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const { id } = (await req.json()) as { id?: string };
  if (!id || !isUuid(id)) return NextResponse.json({ error: "id required" }, { status: 400 });

  const existing = (await db.execute(sql`
    select id, key, name, is_built_in from app_roles
     where id = ${id} and org_id = ${actor.orgId}`)) as any;
  const role = existing.rows[0];
  if (!role) return NextResponse.json({ error: "role not found" }, { status: 404 });
  if (role.is_built_in) {
    return NextResponse.json({ error: "built-in roles cannot be deleted" }, { status: 403 });
  }

  // No DB-level FK cascade yet (informal FKs) — remove assignments explicitly.
  await db.execute(sql`
    delete from role_assignments where role_id = ${id} and org_id = ${actor.orgId}`);
  await db.execute(sql`
    delete from role_dashboard_layouts where role_key = ${role.key} and org_id = ${actor.orgId}`);
  await db.execute(sql`delete from app_roles where id = ${id} and org_id = ${actor.orgId}`);
  await audit({
    orgId: actor.orgId,
    rowId: id,
    action: "delete",
    changes: { key: [role.key, null], name: [role.name, null] },
    actorId: actor.id,
  });
  return NextResponse.json({ ok: true });
}
