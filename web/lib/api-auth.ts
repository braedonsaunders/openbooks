import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import { setRequestOrg } from "./request-org";
import {
  PERMISSION_CATALOGUE,
  permissionSetCovers,
  resolveEffectivePermissions,
} from "./permissions";
import type { SessionUser } from "./auth";

/**
 * API-key authentication for the versioned REST API (`/api/v1/*`).
 *
 * source platform binds a token to a single role and inherits the whole role's
 * permission set — the role IS the scope. openbooks does better: each key
 * carries a SCOPED subset of permission keys (the same `module.action`
 * catalogue roles use). A request is allowed only when BOTH the key's scopes
 * AND the owner's effective permissions cover the required permission — the
 * intersection means a key never grants more than its owner can do.
 *
 * The plaintext key is `ob_live_` + base64url(32 bytes), shown ONCE at
 * creation. At rest we keep the SHA-256 hash (for lookup) and a 4-char tail
 * preview. Every authenticated request records an `api_key_events` row.
 */

const KEY_PREFIX = "ob_live_";

/** Generate a plaintext key + its stored hash/preview artifacts. */
export function generateApiKey(): {
  plaintext: string;
  keyHash: string;
  keyPrefix: string;
  keyPreview: string;
} {
  const secret = randomBytes(32).toString("base64url");
  const plaintext = KEY_PREFIX + secret;
  return {
    plaintext,
    keyHash: sha256(plaintext),
    keyPrefix: plaintext.slice(0, 12),
    keyPreview: secret.slice(-4),
  };
}

function sha256(s: string): string {
  return createHash("sha-256").update(s, "utf8").digest("hex");
}

/** Extract the bearer token from Authorization or X-API-Key. */
export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xKey = req.headers.get("x-api-key");
  if (xKey) return xKey.trim();
  return null;
}

export interface ApiKeyAuth {
  user: SessionUser;
  keyId: string;
  /** Effective scoped permissions (key scopes ∩ owner effective perms). */
  permissions: Set<string>;
}

/**
 * Expand a resolved permission Set (which may contain wildcards like `ap.*`
 * or `*`) into concrete catalogue keys. Used to intersect owner permissions
 * with key scopes.
 */
function expandToCatalogue(perms: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const key of PERMISSION_CATALOGUE) {
    if (permissionSetCovers(perms, key)) out.add(key);
  }
  return out;
}

/**
 * Resolve an API key from a request. Returns null when the token is absent,
 * invalid, revoked, or expired. On success, the scoped permission set is the
 * intersection of the key's scopes with the OWNER's effective permissions — a
 * key never grants more than its owner.
 */
export async function resolveApiKeyAuth(req: Request): Promise<ApiKeyAuth | null> {
  const token = extractBearer(req);
  if (!token) return null;
  if (!token.startsWith(KEY_PREFIX)) return null;

  const keyHash = sha256(token);
  // The key's org isn't known until the row is read — look it up under bypass.
  const keyRow = await withBypassContext(
    async () =>
      (
        (await db.execute(sql`
      select k.id, k.org_id, k.user_id, k.scopes, k.is_active, k.expires_at,
             u.email, u.name, u.role, u.is_active as user_active
        from api_keys k
        join users u on u.id = k.user_id
       where k.key_hash = ${keyHash}
       limit 1`)) as any
      ).rows[0],
  );
  if (!keyRow) return null;
  if (!keyRow.is_active || !keyRow.user_active) return null;
  if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() < Date.now()) return null;

  // Scope the rest of this request to the key's org (RLS enforced).
  setRequestOrg(keyRow.org_id);

  // Resolve the owner's effective permissions (same logic as authz.getAuthz).
  const [assignments, overrides] = (await Promise.all([
    db.execute(sql`
      select r.permissions
        from role_assignments a
        join app_roles r on r.id = a.role_id
       where a.user_id = ${keyRow.user_id} and a.org_id = ${keyRow.org_id}`),
    db.execute(sql`
      select permission, effect
        from user_permission_overrides
       where user_id = ${keyRow.user_id} and org_id = ${keyRow.org_id}`),
  ])) as any[];

  const ownerPerms = resolveEffectivePermissions({
    rolePermissionSets: assignments.rows.map((r: any) =>
      Array.isArray(r.permissions) ? r.permissions : [],
    ),
    legacyRole: keyRow.role,
    overrides: overrides.rows,
  });

  // Expand owner perms to concrete catalogue keys, then intersect with scopes.
  const expanded = expandToCatalogue(ownerPerms);
  const scopes: string[] = Array.isArray(keyRow.scopes) ? keyRow.scopes : [];
  const scopedSet = new Set<string>();
  if (scopes.length === 0) {
    // Empty scopes = inherit owner's full effective permission set.
    for (const p of expanded) scopedSet.add(p);
  } else {
    const scopeSet = new Set(scopes);
    for (const p of expanded) {
      if (permissionSetCovers(scopeSet, p)) scopedSet.add(p);
    }
  }

  const user: SessionUser = {
    id: keyRow.user_id,
    email: keyRow.email,
    name: keyRow.name,
    role: keyRow.role,
    orgId: keyRow.org_id,
    // API keys are always bound to their production org — no sandbox entry.
    envKind: "production",
    productionOrgId: keyRow.org_id,
    isSuperAdmin: false,
    homeUserId: keyRow.user_id,
    homeOrgId: keyRow.org_id,
  };

  // Best-effort last-used update — fire and forget, never blocks the request.
  void db
    .execute(sql`update api_keys set last_used_at = now() where id = ${keyRow.id}`)
    .catch(() => {});

  return { user, keyId: keyRow.id, permissions: scopedSet };
}

/** Wildcard-aware check on the scoped API key permission set. */
export function canApi(auth: ApiKeyAuth, perm: string): boolean {
  return permissionSetCovers(auth.permissions, perm);
}

/**
 * API-route gate for key-authenticated v1 routes. Returns the resolved auth,
 * or a 401/403 JSON response the handler should return directly:
 *
 *   const gate = await guardApiKey("gl.read", req);
 *   if (gate instanceof NextResponse) return gate;
 */
export async function guardApiKey(
  perm: string,
  req: Request,
): Promise<ApiKeyAuth | NextResponse> {
  const auth = await resolveApiKeyAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  }
  if (!canApi(auth, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 });
  }
  return auth;
}

/**
 * Log an API key event (execution log). Fire-and-forget — never blocks the
 * response. Called by the v1 route wrapper after every request.
 */
export function logKeyEvent(args: {
  orgId: string;
  keyId: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  req: Request;
  error?: string;
}): void {
  void db
    .execute(sql`
      insert into api_key_events (org_id, key_id, method, path, status_code, duration_ms, ip_address, user_agent, error)
      values (${args.orgId}, ${args.keyId}, ${args.method}, ${args.path}, ${args.statusCode},
              ${args.durationMs},
              ${args.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null},
              ${args.req.headers.get("user-agent")?.slice(0, 500) ?? null},
              ${args.error ?? null})`)
    .catch(() => {});
}
