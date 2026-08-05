import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Email log — every message the worker dispatches (scheduled reports, test
 * sends, future notifications) is recorded here so an admin can answer "did the
 * report go out?" and replay when a provider hiccups. Org-scoped; the sealed
 * provider secret lives in orgs.settings.email, never here.
 */
export const EMAIL_LOG_STATUSES = ["queued", "sent", "failed", "suppressed"] as const;

export const emailLog = pgTable(
  "email_log",
  {
    id: id(),
    orgId: orgRef(),
    /** BullMQ job id (dedupe / trace); null for direct sends. */
    jobId: text("job_id"),
    /** Provider message id returned on success. */
    providerMessageId: text("provider_message_id"),
    /** Resolved provider used for this send (resend/smtp/…). */
    provider: text("provider"),
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    recipientPrimary: text("recipient_primary"),
    fromAddr: text("from_addr"),
    replyToAddr: text("reply_to_addr"),
    subject: text("subject").notNull(),
    status: text("status", { enum: EMAIL_LOG_STATUSES }).notNull().default("queued"),
    /** e.g. 'report', 'test'. */
    categoryKey: text("category_key"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    ...auditColumns,
  },
  (t) => [
    index("email_log_org").on(t.orgId, t.createdAt),
    index("email_log_status").on(t.orgId, t.status, t.createdAt),
    index("email_log_job").on(t.jobId),
  ],
);

export type EmailLogRow = typeof emailLog.$inferSelect;
export type EmailLogInsert = typeof emailLog.$inferInsert;
