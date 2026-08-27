import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import {
  insertApiKeyEvent,
  transportEvent,
  type ApiRequestAudit,
} from "./application/api-key-audit";
import { setRequestOrg } from "./request-org";
import {
  PERMISSION_CATALOGUE,
  isCataloguePermission,
  permissionSetCovers,
  resolveEffectivePermissions,
} from "./permissions";
import type { SessionUser } from "./auth";
import { allowedSubsidiaryIds } from "./subsidiaries";
import { isFeatureEnabled } from "./features";

/**
 * API-key authentication for the versioned REST API (`/api/v1/*`).
 *
 * source platform binds a token to a single role and inherits the whole role's
 * permission set — the role IS the scope. openbooks does better: each key
 * carries an explicit, non-empty SCOPED subset of permission keys (the same
 * `module.action` catalogue roles use). A request is allowed only when BOTH
 * the key's scopes AND the owner's effective permissions cover the required
 * permission — the intersection means a key never grants more than its owner
 * can do. There is no inherit marker: an omitted, empty, or malformed scope
 * set resolves to nothing and the request is refused.
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
  /** Requests-per-minute ceiling for this key; null = unlimited. */
  rateLimitPerMin: number | null;
  /** Subsidiary visibility inherited from the owning user's role assignments. */
  allowedSubsidiaryIds: Set<string> | null;
  /**
   * Canonical key/request correlation captured at transport entry. Every
   * execution event for this request — the claim transaction's atomic row and
   * the wrapper's own writes alike — is assembled from it.
   */
  audit: ApiRequestAudit;
}

interface ApiKeySqlRow {
  id: string;
  org_id: string;
  user_id: string;
  scopes: unknown;
  is_active: boolean;
  expires_at: string | Date | null;
  rate_limit_per_min: string | number | null;
  email: string;
  name: string;
  user_active: boolean;
}

interface ApiKeyRoleSqlRow {
  key: string;
  name: string;
  permissions: unknown;
}

interface PermissionOverrideSqlRow {
  permission: string;
  effect: "grant" | "deny";
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
export async function resolveApiKeyAuth(
  req: Request,
  startedAt: number = Date.now(),
): Promise<ApiKeyAuth | null> {
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
             k.rate_limit_per_min,
             u.email, u.name, u.is_active as user_active
        from api_keys k
        join users u on u.id = k.user_id
       where k.key_hash = ${keyHash}
       limit 1`)) as unknown as { rows: ApiKeySqlRow[] }
      ).rows[0],
  );
  if (!keyRow) return null;
  if (!keyRow.is_active || !keyRow.user_active) return null;
  if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() < Date.now()) return null;

  // Scope the rest of this request to the key's org (RLS enforced).
  setRequestOrg(keyRow.org_id);

  // Resolve the owner's effective permissions (same logic as authz.getAuthz).
  const [assignmentResult, overrideResult, allowedSubs] = await Promise.all([
    db.execute(sql`
      select r.key, r.name, r.permissions
        from role_assignments a
        join app_roles r on r.id = a.role_id and r.org_id = a.org_id
       where a.user_id = ${keyRow.user_id} and a.org_id = ${keyRow.org_id}`),
    db.execute(sql`
      select permission, effect
        from user_permission_overrides
       where user_id = ${keyRow.user_id} and org_id = ${keyRow.org_id}`),
    allowedSubsidiaryIds(keyRow.user_id),
  ]);
  const assignments = assignmentResult as unknown as { rows: ApiKeyRoleSqlRow[] };
  const overrides = overrideResult as unknown as { rows: PermissionOverrideSqlRow[] };

  const ownerPerms = resolveEffectivePermissions({
    rolePermissionSets: assignments.rows.map((r) =>
      Array.isArray(r.permissions) ? r.permissions : [],
    ),
    overrides: overrides.rows,
  });

  // Expand owner perms to concrete catalogue keys, then intersect with scopes.
  const expanded = expandToCatalogue(ownerPerms);
  // Fail closed on malformed or residual empty scope sets: storage rejects
  // empty arrays outright (api_keys_scopes_non_empty) and scopes are exact
  // catalogue keys only — never wildcards or an inherit marker. A key that
  // cannot state at least one explicit catalogue permission authenticates
  // nothing.
  if (!Array.isArray(keyRow.scopes) || keyRow.scopes.length === 0) return null;
  const scopeSet = new Set(keyRow.scopes.filter((s) => isCataloguePermission(s)));
  if (scopeSet.size === 0) return null;
  const scopedSet = new Set<string>();
  for (const p of expanded) {
    if (permissionSetCovers(scopeSet, p)) scopedSet.add(p);
  }

  const user: SessionUser = {
    id: keyRow.user_id,
    email: keyRow.email,
    name: keyRow.name,
    roles: assignments.rows.map((row) => ({ key: row.key, name: row.name })),
    orgId: keyRow.org_id,
    // API keys are always bound to their production org — no sandbox entry.
    envKind: "production",
    productionOrgId: keyRow.org_id,
    isSuperAdmin: false,
    homeUserId: keyRow.user_id,
    homeOrgId: keyRow.org_id,
  };

  // Durable usage trace: a credential that authenticates successfully always
  // leaves its last-used stamp behind — the request is refused when this (or
  // any) required database write fails, never waved through unrecorded.
  await db
    .execute(sql`update api_keys set last_used_at = now() where id = ${keyRow.id} and org_id = ${keyRow.org_id}`);

  return {
    user,
    keyId: keyRow.id,
    permissions: scopedSet,
    rateLimitPerMin: keyRow.rate_limit_per_min == null ? null : Number(keyRow.rate_limit_per_min),
    allowedSubsidiaryIds: allowedSubs,
    audit: {
      method: req.method,
      path: new URL(req.url).pathname,
      ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      startedAt,
    },
  };
}

/**
 * Fixed-window per-minute rate limit for an authenticated key. One atomic
 * UPDATE on the key row rolls the window and increments the counter (the row
 * lock serializes concurrent requests for the same key), so no extra table or
 * external store is needed. Returns a 429 response to return directly when the
 * key is over its ceiling, or null to proceed. A null ceiling means unlimited.
 */
export async function enforceRateLimit(auth: ApiKeyAuth): Promise<NextResponse | null> {
  if (auth.rateLimitPerMin == null) return null;
  const r = (await db.execute(sql`
    update api_keys
       set rate_window_count = case
             when rate_window_start = date_trunc('minute', now()) then rate_window_count + 1
             else 1 end,
           rate_window_start = date_trunc('minute', now())
     where id = ${auth.keyId} and org_id = ${auth.user.orgId}
     returning rate_window_count as count`));
  const count = Number(r.rows[0]?.count ?? 1);
  if (count <= auth.rateLimitPerMin) return null;

  const retryAfter = Math.max(1, 60 - new Date().getSeconds());
  // Required evidence: a rate-limited key's attempt is still an authenticated
  // execution. A failing write propagates and fails the request closed.
  await insertApiKeyEvent(transportEvent(
    auth.audit,
    { orgId: auth.user.orgId, keyId: auth.keyId },
    { statusCode: 429, error: "rate limit exceeded" },
  ));
  return NextResponse.json(
    { error: `rate limit exceeded (${auth.rateLimitPerMin}/min)` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
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
  const featureGate = await guardApiKeyFeature(auth, "apiAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth);
  if (limited) return limited;
  if (!canApi(auth, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 });
  }
  return auth;
}

/** Fail closed at transport boundaries when a tenant disables an API-backed capability. */
export async function guardApiKeyFeature(
  auth: ApiKeyAuth,
  featureKey: string,
): Promise<NextResponse | null> {
  return (await isFeatureEnabled(auth.user.orgId, featureKey))
    ? null
    : NextResponse.json({ error: "not found" }, { status: 404 });
}
