import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, money, orgRef } from "./helpers";

export const AP_CAPTURE_MAILBOX_PROVIDERS = ["postmark", "mailgun", "sendgrid", "generic"] as const;

export const AP_CAPTURE_INBOUND_OUTCOMES = [
  "received",
  "captured",
  "rejected_sender",
  "no_attachments",
  "duplicate",
  "error",
] as const;

/**
 * Inbound email address for AP capture. Each address belongs to one legal
 * entity; its unguessable token authenticates the provider webhook, and the
 * optional sender list narrows who may submit bills through it. Captures are
 * attributed to the owner, whose standing is re-checked on every delivery.
 */
export const apCaptureMailboxes = pgTable(
  "ap_capture_mailboxes",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    label: text("label").notNull(),
    emailAddress: text("email_address"),
    token: text("token").notNull(),
    provider: text("provider", { enum: AP_CAPTURE_MAILBOX_PROVIDERS }).notNull(),
    allowedSenders: jsonb("allowed_senders")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    rateWindowStart: timestamp("rate_window_start", { withTimezone: true }),
    rateWindowCount: integer("rate_window_count").notNull().default(0),
    ownerUserId: uuid("owner_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("ap_capture_mailboxes_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("ap_capture_mailboxes_token_unique").on(t.token),
    index("ap_capture_mailboxes_subsidiary_idx").on(t.orgId, t.subsidiaryId),
    check("ap_capture_mailboxes_token_check", sql`${t.token} ~ '^[a-z2-7]{32}$'`),
  ],
);

/** The provider signing secret for one address, sealed and kept apart from configuration reads. */
export const apCaptureMailboxCredentials = pgTable(
  "ap_capture_mailbox_credentials",
  {
    id: id(),
    orgId: orgRef(),
    mailboxId: uuid("mailbox_id").notNull(),
    sealedSecret: text("sealed_secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("ap_capture_mailbox_credentials_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("ap_capture_mailbox_credentials_mailbox_unique").on(t.orgId, t.mailboxId),
  ],
);

/**
 * One inbound AP email, idempotent on its address and message id. The
 * received facts (including signature evidence) are immutable; the outcome
 * is written once, and an unfinished message may be re-claimed after its
 * processing lease expires.
 */
export const apCaptureInboundMessages = pgTable(
  "ap_capture_inbound_messages",
  {
    id: id(),
    orgId: orgRef(),
    mailboxId: uuid("mailbox_id").notNull(),
    messageId: text("message_id").notNull(),
    provider: text("provider", { enum: AP_CAPTURE_MAILBOX_PROVIDERS }).notNull(),
    fromAddress: text("from_address"),
    subject: text("subject"),
    attachmentCount: integer("attachment_count").notNull(),
    contentDigest: text("content_digest").notNull(),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    providerNonce: text("provider_nonce"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    claimAttempt: integer("claim_attempt").notNull().default(1),
    outcome: text("outcome", { enum: AP_CAPTURE_INBOUND_OUTCOMES }).notNull().default("received"),
    outcomeReason: text("outcome_reason"),
    captureItemIds: uuid("capture_item_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ap_capture_inbound_messages_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("ap_capture_inbound_messages_message_unique").on(t.orgId, t.mailboxId, t.messageId),
    uniqueIndex("ap_capture_inbound_messages_nonce_unique")
      .on(t.orgId, t.mailboxId, t.providerNonce)
      .where(sql`${t.providerNonce} is not null`),
    index("ap_capture_inbound_messages_recent_idx").on(t.orgId, t.receivedAt),
  ],
);

/**
 * Effective-dated policy for posting captured bills from vendors whose most
 * recent captures were accepted unchanged and posted. Versions are immutable;
 * no version reads as off.
 */
export const apCaptureAutopostPolicies = pgTable(
  "ap_capture_autopost_policies",
  {
    id: id(),
    orgId: orgRef(),
    effectiveFrom: date("effective_from").notNull(),
    enabled: boolean("enabled").notNull(),
    cleanStreak: integer("clean_streak").notNull(),
    maxAmount: money("max_amount"),
    maxAmountCurrency: text("max_amount_currency"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("ap_capture_autopost_policies_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("ap_capture_autopost_policies_effective_unique").on(t.orgId, t.effectiveFrom),
    check("ap_capture_autopost_policies_streak_check", sql`${t.cleanStreak} between 2 and 20`),
    check(
      "ap_capture_autopost_policies_limit_currency",
      sql`(${t.maxAmount} is null) = (${t.maxAmountCurrency} is null)`,
    ),
  ],
);
