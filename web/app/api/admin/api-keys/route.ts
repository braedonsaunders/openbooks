import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { generateApiKey } from "../../../../lib/api-auth";
import {
  isCataloguePermission,
  PERMISSION_CATALOGUE,
} from "../../../../lib/permissions";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * API key management. Gated by `api.keys.manage`. Keys are org-scoped and
 * owned by the creating user. The plaintext key is returned ONLY at creation
 * — at rest we keep the SHA-256 hash + a 4-char preview. Revocation is
 * `is_active = false` (preserves the audit/event log). Every change is
 * recorded in audit_log.
 */

function normalizeScopes(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const set = new Set<string>();
  for (const p of input) {
    if (typeof p !== "string" || !isCataloguePermission(p)) return null;
    set.add(p);
  }
  return PERMISSION_CATALOGUE.filter((p) => set.has(p));
}

/**
 * Parse a requests-per-minute value. Returns a positive integer, `null`
 * (unlimited), `undefined` (not specified — keep the default/current), or
 * `false` (invalid → 400).
 */
function parseRate(input: unknown): number | null | undefined | false {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) return false;
  return n;
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
    values (${args.orgId}, 'api_keys', ${args.rowId}, ${args.action},
            ${JSON.stringify(args.changes)}, ${args.actorId})`);
}

/** List all keys in the org (without secrets). */
export async function GET() {
  const gate = await guardFeaturePermission("api.keys.manage", "apiAccess");
  if (gate instanceof NextResponse) return gate;

  const r = (await db.execute(sql`
    select k.id, k.name, k.description, k.key_prefix, k.key_preview, k.scopes,
           k.rate_limit_per_min, k.is_active, k.expires_at, k.last_used_at, k.created_at,
           u.name as owner_name, u.email as owner_email
      from api_keys k
      join users u on u.id = k.user_id
     where k.org_id = ${gate.user.orgId}
     order by k.created_at desc`)) as any;

  return NextResponse.json({ keys: r.rows });
}

/** Create a new key — returns the plaintext ONCE. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission("api.keys.manage", "apiAccess");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    name?: string;
    description?: string;
    scopes?: unknown;
    expiresAt?: string | null;
    rateLimitPerMin?: number | null;
  };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const scopes = normalizeScopes(body.scopes ?? []);
  if (!scopes) {
    return NextResponse.json({ error: "scopes must be known catalogue keys" }, { status: 400 });
  }

  const rate = parseRate(body.rateLimitPerMin);
  if (rate === false) {
    return NextResponse.json({ error: "rateLimitPerMin must be a positive integer or blank" }, { status: 400 });
  }
  // Default to 120/min when unspecified; null = unlimited.
  const rateValue = rate === undefined ? 120 : rate;

  let expiresAt: string | null = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (isNaN(d.getTime())) {
      return NextResponse.json({ error: "invalid expiresAt" }, { status: 400 });
    }
    expiresAt = d.toISOString();
  }

  const gen = generateApiKey();
  const inserted = (await db.execute(sql`
    insert into api_keys (org_id, user_id, name, description, key_prefix, key_hash,
                          key_preview, scopes, rate_limit_per_min, is_active, expires_at, created_by, updated_by)
    values (${actor.orgId}, ${actor.id}, ${name}, ${body.description?.trim() || null},
            ${gen.keyPrefix}, ${gen.keyHash}, ${gen.keyPreview},
            ${JSON.stringify(scopes)}, ${rateValue}, true, ${expiresAt}, ${actor.id}, ${actor.id})
    returning id`)) as any;

  await audit({
    orgId: actor.orgId, rowId: inserted.rows[0].id, action: "insert",
    changes: { name: [null, name], scopes: [null, scopes], scopesCount: scopes.length },
    actorId: actor.id,
  });

  return NextResponse.json({ id: inserted.rows[0].id, plaintext: gen.plaintext }, { status: 201 });
}

/** Update a key — name, description, scopes, or revoke (is_active = false). */
export async function PATCH(req: Request) {
  const gate = await guardFeaturePermission("api.keys.manage", "apiAccess");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as {
    id?: string;
    name?: string;
    description?: string;
    scopes?: unknown;
    isActive?: boolean;
    rateLimitPerMin?: number | null;
  };
  if (!body.id || !isUuid(body.id)) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const existing = (await db.execute(sql`
    select id, name, description, scopes, rate_limit_per_min, is_active
      from api_keys where id = ${body.id} and org_id = ${actor.orgId}`)) as any;
  const key = existing.rows[0];
  if (!key) return NextResponse.json({ error: "key not found" }, { status: 404 });

  const changes: Record<string, unknown> = {};
  const sets: SQL[] = [];

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    sets.push(sql`name = ${name}`);
    changes.name = [key.name, name];
  }
  if (body.description !== undefined) {
    const desc = body.description.trim() || null;
    sets.push(sql`description = ${desc}`);
    changes.description = [key.description, desc];
  }
  if (body.scopes !== undefined) {
    const scopes = normalizeScopes(body.scopes);
    if (!scopes) {
      return NextResponse.json({ error: "scopes must be known catalogue keys" }, { status: 400 });
    }
    sets.push(sql`scopes = ${JSON.stringify(scopes)}`);
    changes.scopes = [key.scopes, scopes];
  }
  if (body.isActive !== undefined) {
    sets.push(sql`is_active = ${body.isActive}`);
    changes.is_active = [key.is_active, body.isActive];
  }
  if (body.rateLimitPerMin !== undefined) {
    const rate = parseRate(body.rateLimitPerMin);
    if (rate === false) {
      return NextResponse.json({ error: "rateLimitPerMin must be a positive integer or blank" }, { status: 400 });
    }
    sets.push(sql`rate_limit_per_min = ${rate}`);
    changes.rate_limit_per_min = [key.rate_limit_per_min, rate];
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  await db.execute(sql`
    update api_keys
       set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${actor.id}
     where id = ${body.id} and org_id = ${actor.orgId}`);

  await audit({ orgId: actor.orgId, rowId: body.id, action: "update", changes, actorId: actor.id });
  return NextResponse.json({ ok: true });
}

/** Revoke a key (soft-delete: is_active = false, preserves audit trail). */
export async function DELETE(req: Request) {
  const gate = await guardFeaturePermission("api.keys.manage", "apiAccess");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const parsedBody3 = await parseJsonBody(req, jsonObject);
  if (!parsedBody3.ok) return parsedBody3.response;
  const { id } = (parsedBody3.data) as { id?: string };
  if (!id || !isUuid(id)) return NextResponse.json({ error: "id required" }, { status: 400 });

  const existing = (await db.execute(sql`
    select id, name, key_prefix, is_active from api_keys
     where id = ${id} and org_id = ${actor.orgId}`)) as any;
  const key = existing.rows[0];
  if (!key) return NextResponse.json({ error: "key not found" }, { status: 404 });

  // Soft-delete: mark inactive so the event log retains its references.
  await db.execute(sql`
    update api_keys set is_active = false, updated_at = now(), updated_by = ${actor.id}
     where id = ${id} and org_id = ${actor.orgId}`);

  await audit({
    orgId: actor.orgId, rowId: id, action: "delete",
    changes: { name: [key.name, null], key_prefix: [key.key_prefix, null] },
    actorId: actor.id,
  });
  return NextResponse.json({ ok: true });
}
