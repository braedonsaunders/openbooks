import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { generateApiKey } from "../../../../lib/api-auth";
import {
  isCataloguePermission,
  PERMISSION_CATALOGUE,
} from "../../../../lib/permissions";
import {
  permissionsOutsideCeiling,
  resolveEffectivePermissions,
  resolveKeyScopeAuthority,
} from "@openbooks/engine/src/organization/permissions.ts";
import {
  actorAllowedSubsidiaryIds,
  subsidiaryScopeWithinCeiling,
} from "@openbooks/engine/src/organization/actor-subsidiaries.ts";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * API key management. Gated by `api.keys.manage`. Keys are org-scoped and
 * owned by the creating user. The plaintext key is returned ONLY at creation
 * — at rest we keep the SHA-256 hash + a 4-char preview.
 *
 * Scopes are the grant contract: every key must state at least one explicit
 * catalogue permission. Omitted or empty scope sets are rejected (400), never
 * defaulted to the owner's permission set — storage enforces the same
 * invariant (api_keys_scopes_non_empty) for every other writer.
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
 *
 * Privilege ceiling: `api.keys.manage` is an ordinary permission, so an
 * editor may only grant scopes they hold themselves (creation grants the full
 * request; updates grant only ADDED scopes) and may only resume a suspended
 * key whose re-enabled authority (key scopes ∩ the OWNER's current
 * permissions) sits inside their own. A subsidiary-restricted editor
 * likewise cannot widen or resume a key whose owner sees more entities.
 * Fresh grants to a deactivated owner's key are refused until the owner is
 * reactivated (the trusted lens is empty for inactive users and would hide
 * their stored entity policy). Super admins are exempt. Narrowing, metadata
 * edits, suspension, and terminal revocation stay available to every
 * key-manager.
 */

/**
 * Refusal for a grant above the editor's own authority. Names the missing
 * permissions (the canonical `admin.users.manage` ceiling shape) and the
 * remedy that exists: an administrator who holds them, or narrower scopes.
 */
function ceilingRefusal(missing: string[]) {
  return NextResponse.json(
    {
      error: `cannot grant permissions you do not hold: ${missing.join(", ")} — ask an administrator who holds them, or narrow the scopes`,
      missing,
    },
    { status: 403 },
  );
}

/**
 * Refusal for a grant that would widen authority across entities the editor
 * cannot see. The remedy names who can actually make the change: an
 * administrator whose subsidiary visibility covers the key owner's own —
 * unrestricted visibility is required only when the owner sees everything.
 */
function subsidiaryScopeRefusal(ownerLens: ReadonlySet<string> | null | undefined) {
  const remedy =
    ownerLens === null
      ? "ask an administrator with unrestricted subsidiary visibility to make this change"
      : "ask an administrator whose subsidiary visibility covers the key owner's subsidiaries to make this change";
  return NextResponse.json(
    { error: `cannot grant access across subsidiaries you cannot see — ${remedy}` },
    { status: 403 },
  );
}

/**
 * Refusal for widening a deactivated owner's key. The trusted entity lens
 * resolves EMPTY for inactive users, which would hide the owner's stored
 * broader entity policy — so fresh grants wait until the owner is active
 * again instead of being ceiling-checked against a lens of nothing.
 */
function inactiveOwnerRefusal() {
  return NextResponse.json(
    { error: "the key owner is deactivated — reactivate the owner before widening their key" },
    { status: 409 },
  );
}

/** Whether the key owner is currently active (unknown owners fail closed). */
async function ownerIsActive(orgId: string, ownerId: string): Promise<boolean> {
  const row = (
    await db.execute<{ isActive: boolean }>(sql`
    select is_active as "isActive" from users where id = ${ownerId} and org_id = ${orgId}`)
  ).rows[0];
  return row?.isActive === true;
}

/**
 * The key owner's CURRENT effective permissions, resolved exactly the way
 * `resolveApiKeyAuth` resolves them at use time (union of assigned role
 * permission sets, grant overrides added, deny overrides winning) so the
 * resume ceiling compares against authority the key would really confer.
 */
async function ownerEffectivePermissions(orgId: string, ownerId: string): Promise<Set<string>> {
  const assignments = (await db.execute<{ permissions: unknown }>(sql`
    select r.permissions
      from role_assignments a
      join app_roles r on r.id = a.role_id and r.org_id = a.org_id
     where a.user_id = ${ownerId} and a.org_id = ${orgId}`));
  const overrides = (await db.execute<{ permission: string; effect: "grant" | "deny" }>(sql`
    select permission, effect
      from user_permission_overrides
     where user_id = ${ownerId} and org_id = ${orgId}`));
  return resolveEffectivePermissions({
    rolePermissionSets: assignments.rows.map((r) =>
      Array.isArray(r.permissions) ? r.permissions.filter((p): p is string => typeof p === "string") : [],
    ),
    overrides: overrides.rows,
  });
}

/** Normalize a scopes payload to catalogue keys, or null when invalid/empty. */
function normalizeScopes(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
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
    description?: string | null;
    scopes?: unknown;
    expiresAt?: string | null;
    rateLimitPerMin?: number | null;
  };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (
    body.description !== undefined &&
    body.description !== null &&
    typeof body.description !== "string"
  ) {
    return NextResponse.json({ error: "description must be a string" }, { status: 400 });
  }

  // An omitted or empty scope set is a rejected request, never a
  // full-permission credential.
  const scopes = normalizeScopes(body.scopes);
  if (!scopes) {
    return NextResponse.json(
      { error: "at least one scope is required; scopes must be known catalogue keys" },
      { status: 400 },
    );
  }

  // Creation grants the full request, so every scope must sit inside the
  // editor's own authority. The new key is owned by the editor, so its
  // subsidiary lens is the editor's own — no cross-entity grant is possible
  // here; the PATCH path checks the entity ceiling for other owners' keys.
  if (!actor.isSuperAdmin) {
    const missing = permissionsOutsideCeiling(gate.permissions, scopes);
    if (missing.length > 0) return ceilingRefusal(missing);
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
  const description = typeof body.description === "string" ? body.description.trim() || null : null;
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
    description?: string | null;
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
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    fields.name = name;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      return NextResponse.json({ error: "description must be a string" }, { status: 400 });
    }
    fields.description = body.description === null ? null : body.description.trim() || null;
  }
  if (body.scopes !== undefined) {
    // Clearing scopes to [] would mint a key whose grant contract is empty;
    // a key is narrowed or revoked, never blanked.
    const scopes = normalizeScopes(body.scopes);
    if (!scopes) {
      return NextResponse.json(
        { error: "at least one scope is required; scopes must be known catalogue keys" },
        { status: 400 },
      );
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
  // isActive is a strict boolean: a truthy non-boolean (e.g. the string
  // "true") would otherwise slip past the revoked-key reactivation guard below
  // (which compares against `true`) while still being written to the boolean
  // column, and any other non-boolean aborts the update with an unhandled
  // storage error.
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
  }
  const wantsReactivation = body.isActive === true;
  if (body.isActive !== undefined) fields.isActive = body.isActive;
  if (Object.values(fields).every((value) => value === undefined)) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  return withOrgTransaction(actor.orgId, async () => {
    const existing = (await db.execute(sql`
      select id, user_id, name, description, scopes, rate_limit_per_min, is_active
        from api_keys
       where id = ${keyId} and org_id = ${actor.orgId}
       for update`)) as unknown as {
      rows: Array<{
        id: string;
        user_id: string;
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

    const storedScopes = Array.isArray(key.scopes)
      ? key.scopes.filter((s): s is string => typeof s === "string")
      : [];
    const storedSet = new Set(storedScopes);
    const added = fields.scopes ? fields.scopes.filter((s) => !storedSet.has(s)) : [];
    const finalScopes = fields.scopes ?? storedScopes;
    const resumes = wantsReactivation && !key.is_active;

    // Privilege ceiling for the two ways PATCH grants authority. Untouched
    // scopes are never re-checked, so narrowing, metadata edits, suspension,
    // and revocation stay available to every key-manager.
    if (!actor.isSuperAdmin && (added.length > 0 || resumes)) {
      const active = await ownerIsActive(actor.orgId, key.user_id);
      // Fresh grants to a deactivated owner's key are refused outright: the
      // trusted entity lens resolves EMPTY for inactive users, which would
      // hide the owner's stored broader entity policy. A resume re-enables
      // nothing while the owner stays inactive (use-time auth requires an
      // active owner), so it keeps the no-effective-authority treatment.
      if (added.length > 0 && !active) return inactiveOwnerRefusal();
      if (added.length > 0) {
        const missing = permissionsOutsideCeiling(gate.permissions, added);
        if (missing.length > 0) return ceilingRefusal(missing);
      }
      // Resuming re-enables exactly the intersection of the key's scopes
      // with the OWNER's current permissions — inert scopes the owner cannot
      // use grant nothing, so only that effective authority is ceiling-checked.
      let effective: string[] = [];
      if (resumes && active && finalScopes.length > 0) {
        // An empty set here is valid-but-inert authority (zero), not an
        // invalid declaration — the resume keeps its no-authority treatment.
        effective = [
          ...(resolveKeyScopeAuthority(
            await ownerEffectivePermissions(actor.orgId, key.user_id),
            finalScopes,
          ) ?? []),
        ];
        if (effective.length > 0) {
          const missing = permissionsOutsideCeiling(gate.permissions, effective);
          if (missing.length > 0) return ceilingRefusal(missing);
        }
      }
      // Entity scope: a subsidiary-restricted editor must not grant the same
      // permission across all entities through an unrestricted (or wider)
      // key owner. A resume that re-enables no effective authority grants
      // nothing, so it needs no entity check.
      if (added.length > 0 || effective.length > 0) {
        const ownerLens = await actorAllowedSubsidiaryIds(db, actor.orgId, key.user_id);
        if (!subsidiaryScopeWithinCeiling(gate.allowedSubsidiaryIds, ownerLens)) {
          return subsidiaryScopeRefusal(ownerLens);
        }
      }
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

    // Destroy the credential hash with a discarded secret. A direct
    // is_active=true write therefore cannot revive the compromised bearer
    // (no presented secret can match the destroyed hash, and the API
    // refuses reactivation of revoked keys). The stored prefix/preview are
    // deliberately kept: they were already visible while the key was
    // active, and keeping them keeps the masked display stable across
    // revoke (F-t01-011).
    const destroyed = generateApiKey();
    await db.execute(sql`
      update api_keys
         set is_active = false,
             key_hash = ${destroyed.keyHash},
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
          key_prefix: key.key_prefix,
          is_active: false,
          credential_material: "destroyed",
        },
      },
      actorId: actor.id,
    });
    return NextResponse.json({ ok: true });
  });
}
