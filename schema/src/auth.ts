import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id } from "./helpers";

/**
 * Authentication tables deliberately have no org_id. Authentication happens
 * before an organization is selected, and a login identity can reach several
 * production organizations and sandboxes. These tables are therefore accessed
 * only by the trusted server-side authentication boundary.
 */

/** Server-side record for each browser session, enabling selective revocation. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    authMethod: text("auth_method", { enum: ["password", "oidc"] }).notNull(),
    networkHash: text("network_hash"),
    userAgentHash: text("user_agent_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_hash").on(t.tokenHash),
    index("auth_sessions_user_active").on(t.userId, t.revokedAt, t.expiresAt),
    index("auth_sessions_expiry").on(t.expiresAt),
  ],
);

/**
 * Distributed password/MFA lockout state. emailHash is an HMAC, never an email
 * address, and rows are also created for unknown identities to avoid an
 * account-enumeration side channel.
 */
export const authLoginState = pgTable(
  "auth_login_state",
  {
    emailHash: text("email_hash").primaryKey(),
    userId: uuid("user_id"),
    failureCount: integer("failure_count").notNull().default(0),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("auth_login_state_user").on(t.userId),
    index("auth_login_state_locked").on(t.lockedUntil),
    index("auth_login_state_updated").on(t.updatedAt),
  ],
);

/** Privacy-preserving authentication event ledger used for audit and limits. */
export const authLoginEvents = pgTable(
  "auth_login_events",
  {
    id: id(),
    userId: uuid("user_id"),
    emailHash: text("email_hash").notNull(),
    networkHash: text("network_hash"),
    userAgentHash: text("user_agent_hash"),
    outcome: text("outcome", {
      enum: [
        "success",
        "failure",
        "locked",
        "rate_limited",
        "mfa_required",
        "mfa_failure",
        "oidc_failure",
      ],
    }).notNull(),
    authMethod: text("auth_method", { enum: ["password", "oidc"] }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("auth_login_events_email_time").on(t.emailHash, t.occurredAt),
    index("auth_login_events_network_time").on(t.networkHash, t.occurredAt),
    index("auth_login_events_user_time").on(t.userId, t.occurredAt),
    index("auth_login_events_retention").on(t.occurredAt),
  ],
);

/** Pending or enabled TOTP factor and one-time recovery-code hashes. */
export const authMfaFactors = pgTable(
  "auth_mfa_factors",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    recoveryCodeHashes: jsonb("recovery_code_hashes").$type<string[]>().notNull().default([]),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    lastUsedStep: integer("last_used_step"),
    /** Pending enrollment is short-lived and bound to its initiating session. */
    setupSessionId: uuid("setup_session_id"),
    setupExpiresAt: timestamp("setup_expires_at", { withTimezone: true }),
    setupAttemptCount: integer("setup_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_mfa_factors_user").on(t.userId),
    index("auth_mfa_factors_setup_expiry").on(t.setupExpiresAt),
  ],
);

/**
 * Small fixed-window ingress buckets. The deployment-wide row provides a
 * coarse abuse ceiling even when no trusted reverse proxy supplies client IPs.
 */
export const authRateLimitBuckets = pgTable(
  "auth_rate_limit_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_rate_limit_buckets_updated").on(t.updatedAt)],
);

/** Short-lived, one-use bridge between primary authentication and local MFA. */
export const authLoginChallenges = pgTable(
  "auth_login_challenges",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    emailHash: text("email_hash").notNull(),
    authMethod: text("auth_method", { enum: ["password", "oidc"] }).notNull(),
    networkHash: text("network_hash"),
    userAgentHash: text("user_agent_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("auth_login_challenges_user").on(t.userId, t.expiresAt),
    index("auth_login_challenges_expiry").on(t.expiresAt),
  ],
);

/** Stable OIDC subject mapping; email is used only for the first safe link. */
export const authOidcIdentities = pgTable(
  "auth_oidc_identities",
  {
    id: id(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id").notNull(),
    emailAtLink: text("email_at_link").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("auth_oidc_identities_subject").on(t.issuer, t.subject),
    uniqueIndex("auth_oidc_identities_user_issuer").on(t.userId, t.issuer),
    index("auth_oidc_identities_user").on(t.userId),
  ],
);
