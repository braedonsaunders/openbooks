import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/db.ts";
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
 * — at rest we keep the SHA-256 hash + a 4-char preview.
 *
 * Suspending a key (`PATCH isActive=false`) is reversible through an explicit,
 * audited resume. Revocation (`DELETE`) is terminal: the stored credential
 * material is replaced with artifacts from a discarded secret, so the old
 * bearer token cannot authenticate even if `is_active` is later changed by a
 * direct write. The append-only revocation audit record also blocks API
 * reactivation; restoring access requires a newly generated key.
 *
 * Each mutation and its redacted audit evidence commit in one
 * `withOrgTransaction` unit. Audit failure therefore rolls the mutation back,
 * and a one-time plaintext is returned only after its creation unit commits.
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

/** The append-only `delete` audit record is the durable terminal marker. */
async function hasRevocationRecord(orgId: string, rowId: string): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 from audit_log
     where org_id = ${orgId}
       and table_name = 'api_keys'
       and row_id = ${rowId}
       and action = 'delete'
     limit 1`);
  return result.rows.length > 0;
}

/** List all keys in the org (without secrets). */
export async function GET() {
  const gate = await guardFeaturePermission("api.keys.manage", "apiAccess");
  if (gate instanceof NextResponse) return gate;

  const r = ((await db.execute(sql`
    select k.id, k.name, k.description, k.key_prefix, k.key_preview, k.scopes,
           k.rate_limit_per_min, k.is_active, k.expires_at, k.last_used_at, k.created_at,
           u.name as owner_name, u.email as owner_email
      from api_keys k
      join users u on u.id = k.user_id
     where k.org_id = ${gate.user.orgId}
     order by k.created_at desc`)));

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
  const description = body.description?.trim() || null;
  const insertedId = await withOrgTransaction(actor.orgId, async () => {
    const inserted = (await db.execute(sql`
      insert into api_keys (org_id, user_id, name, description, key_prefix, key_hash,
                            key_preview, scopes, rate_limit_per_min, is_active, expires_at, created_by, updated_by)
      values (${actor.orgId}, ${actor.id}, ${name}, ${description},
              ${gen.keyPrefix}, ${gen.keyHash}, ${gen.keyPreview},
              ${JSON.stringify(scopes)}, ${rateValue}, true, ${expiresAt}, ${actor.id}, ${actor.id})
      returning id`)) as unknown as { rows: Array<{ id: string }> };
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("api key insert did not return an id");

    await audit({
      orgId: actor.orgId,
      rowId: id,
      action: "insert",
      changes: {
        before: null,
        after: {
          name,
          description,
          scopes,
          rate_limit_per_min: rateValue,
          is_active: true,
          expires_at: expiresAt,
        },
      },
      actorId: actor.id,
    });
    return id;
  });

  return NextResponse.json({ id: insertedId, plaintext: gen.plaintext }, { status: 201 });
}

/** Update a key — name, description, scopes, suspension/resume, or rate limit. */
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
  const keyId = body.id;

  const fields = {
    name: undefined as string | undefined,
    description: undefined as string | null | undefined,
    scopes: undefined as string[] | undefined,
    isActive: undefined as boolean | undefined,
    rateLimitPerMin: undefined as number | null | undefined,
  };
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    fields.name = name;
  }
  if (body.description !== undefined) {
    fields.description = body.description.trim() || null;
  }
  if (body.scopes !== undefined) {
    const scopes = normalizeScopes(body.scopes);
    if (!scopes) {
      return NextResponse.json({ error: "scopes must be known catalogue keys" }, { status: 400 });
    }
    fields.scopes = scopes;
  }
  if (body.rateLimitPerMin !== undefined) {
    const rate = parseRate(body.rateLimitPerMin);
    if (rate === false) {
      return NextResponse.json({ error: "rateLimitPerMin must be a positive integer or blank" }, { status: 400 });
    }
    fields.rateLimitPerMin = rate;
  }
  const wantsReactivation = body.isActive === true;
  if (body.isActive !== undefined) fields.isActive = body.isActive;
  if (Object.values(fields).every((value) => value === undefined)) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  return withOrgTransaction(actor.orgId, async () => {
    const existing = (await db.execute(sql`
      select id, name, description, scopes, rate_limit_per_min, is_active
        from api_keys
       where id = ${keyId} and org_id = ${actor.orgId}
       for update`)) as unknown as {
      rows: Array<{
        id: string;
        name: string;
        description: string | null;
        scopes: unknown;
        rate_limit_per_min: number | null;
        is_active: boolean;
      }>;
    };
    const key = existing.rows[0];
    if (!key) return NextResponse.json({ error: "key not found" }, { status: 404 });

    if (wantsReactivation && (await hasRevocationRecord(actor.orgId, keyId))) {
      return NextResponse.json(
        { error: "this key was revoked; revocation is permanent — create a new key" },
        { status: 409 },
      );
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const sets: SQL[] = [];
    if (fields.name !== undefined) {
      sets.push(sql`name = ${fields.name}`);
      before.name = key.name;
      after.name = fields.name;
    }
    if (fields.description !== undefined) {
      sets.push(sql`description = ${fields.description}`);
      before.description = key.description;
      after.description = fields.description;
    }
    if (fields.scopes !== undefined) {
      sets.push(sql`scopes = ${JSON.stringify(fields.scopes)}`);
      before.scopes = key.scopes;
      after.scopes = fields.scopes;
    }
    if (fields.isActive !== undefined) {
      sets.push(sql`is_active = ${fields.isActive}`);
      before.is_active = key.is_active;
      after.is_active = fields.isActive;
    }
    if (fields.rateLimitPerMin !== undefined) {
      sets.push(sql`rate_limit_per_min = ${fields.rateLimitPerMin}`);
      before.rate_limit_per_min = key.rate_limit_per_min;
      after.rate_limit_per_min = fields.rateLimitPerMin;
    }

    await db.execute(sql`
      update api_keys
         set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${actor.id}
       where id = ${keyId} and org_id = ${actor.orgId}`);

    await audit({
      orgId: actor.orgId,
      rowId: keyId,
      action: "update",
      changes: { before, after },
      actorId: actor.id,
    });
    return NextResponse.json({ ok: true });
  });
}

/** Revoke a key permanently while preserving its row and event references. */
export async function DELETE(req: Request) {
  const gate = await guardFeaturePermission("api.keys.manage", "apiAccess");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const parsedBody3 = await parseJsonBody(req, jsonObject);
  if (!parsedBody3.ok) return parsedBody3.response;
  const { id } = (parsedBody3.data) as { id?: string };
  if (!id || !isUuid(id)) return NextResponse.json({ error: "id required" }, { status: 400 });

  return withOrgTransaction(actor.orgId, async () => {
    const existing = (await db.execute(sql`
      select id, name, key_prefix, is_active
        from api_keys
       where id = ${id} and org_id = ${actor.orgId}
       for update`)) as unknown as {
      rows: Array<{ id: string; name: string; key_prefix: string; is_active: boolean }>;
    };
    const key = existing.rows[0];
    if (!key) return NextResponse.json({ error: "key not found" }, { status: 404 });

    // Destroy the stored lookup artifacts with a discarded secret. A direct
    // is_active=true write therefore cannot revive the compromised bearer.
    const destroyed = generateApiKey();
    await db.execute(sql`
      update api_keys
         set is_active = false,
             key_hash = ${destroyed.keyHash},
             key_prefix = ${destroyed.keyPrefix},
             key_preview = ${destroyed.keyPreview},
             updated_at = now(),
             updated_by = ${actor.id}
       where id = ${id} and org_id = ${actor.orgId}`);

    await audit({
      orgId: actor.orgId,
      rowId: id,
      action: "delete",
      changes: {
        before: {
          name: key.name,
          key_prefix: key.key_prefix,
          is_active: key.is_active,
          credential_material: "stored",
        },
        after: {
          name: key.name,
          key_prefix: "[destroyed]",
          is_active: false,
          credential_material: "destroyed",
        },
      },
      actorId: actor.id,
    });
    return NextResponse.json({ ok: true });
  });
}
