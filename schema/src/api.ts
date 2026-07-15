import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";
import type { PermissionKey } from "./iam";

/**
 * API keys — bearer/X-API-Key credentials for the versioned REST API
 * (`/api/v1/*`). NetSuite binds a token to a single role and inherits the
 * whole role; openbooks does better with SCOPED tokens: each key carries a
 * subset of permission keys (the same `module.action` catalogue roles use),
 * and a request is allowed only when the key's scopes AND the owner's
 * effective permissions both cover the required permission. The intersection
 * means a key never grants more than its owner can do.
 *
 * The plaintext key is shown ONCE at creation (the `ob_live_…` prefix + a
 * 32-byte URL-safe random secret). At rest we keep only the SHA-256 hash
 * (for constant-time lookup) and a 4-char tail preview for the UI. Revocation
 * is `is_active = false` (keeps the audit trail); optional `expires_at` for
 * rotation policies. Every authenticated request records a row in
 * `api_key_events` for observability (NetSuite's per-surface execution log,
 * baked in from day one).
 */

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    orgId: orgRef(),
    /**
     * Owning user. The key's effective permission ceiling is the owner's
     * effective permissions (roles + overrides), intersected with `scopes`.
     */
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * `ob_live_` + 7-char prefix of the secret, for the list view
     * ("Production sync · ob_live_aBc1…"). Not secret — it identifies the
     * key without revealing it.
     */
    keyPrefix: text("key_prefix").notNull(),
    /** SHA-256 hex of the full plaintext key — the lookup index. */
    keyHash: text("key_hash").notNull(),
    /** Last 4 chars of the secret for the "…abcd" preview. */
    keyPreview: text("key_preview").notNull(),
    /**
     * Scoped permission keys (a subset of the catalogue). Empty array =
     * inherit the owner's full effective permission set (a "full-scope" key,
     * closest to NetSuite's role-bound token).
     */
    scopes: jsonb("scopes").$type<PermissionKey[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    /** Null = no expiry. Set for rotation policies. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Updated on every authenticated request (best-effort, non-blocking). */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("api_keys_hash").on(t.keyHash),
    index("api_keys_org").on(t.orgId),
    index("api_keys_org_user").on(t.orgId, t.userId),
  ],
);

/**
 * API key event log — the per-surface execution log (the NetSuite Integration
 * record's execution-log subtab, but built in). One row per authenticated
 * `/api/v1/*` request: method, path, status, latency, and the key that made
 * it. Append-only (no updates); kept for audit + observability. Null `key_id`
 * records failed-auth attempts (bad token, revoked key, expired) so the admin
 * can see probes.
 */
export const apiKeyEvents = pgTable(
  "api_key_events",
  {
    id: id(),
    orgId: orgRef(),
    /** Null for failed-auth attempts where the key could not be resolved. */
    keyId: uuid("key_id"),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("api_key_events_key").on(t.keyId),
    index("api_key_events_org_created").on(t.orgId, t.createdAt),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass — referential-integrity.sql):
  api_keys.org_id             → orgs.id ON DELETE CASCADE
  api_keys.user_id            → users.id ON DELETE CASCADE
  api_keys.created_by         → users.id
  api_keys.updated_by         → users.id
  api_key_events.org_id       → orgs.id ON DELETE CASCADE
  api_key_events.key_id       → api_keys.id ON DELETE SET NULL
*/
