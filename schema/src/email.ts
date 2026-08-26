import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Email log — every message the worker dispatches (scheduled reports, test
 * sends, future notifications) is recorded here so an admin can answer "did the
 * report go out?" and replay when a provider hiccups. Org-scoped; the sealed
 * provider secret lives in orgs.settings.email, never here.
 *
 * Every row is attributable: an interactive send records its acting user in
 * the canonical created_by audit column; an automated send leaves created_by
 * null and stamps explicit system provenance onto meta (actorKind 'system' +
 * actorReason). A null created_by therefore always means "the system sent
 * this", never "nobody recorded who sent it".
 */
export const EMAIL_LOG_STATUSES = ["queued", "sent", "failed", "suppressed"] as const;

/**
 * Who caused a message to be sent. A user actor is written to the canonical
 * created_by audit column; a system actor leaves created_by null and carries
 * its reason in meta.actorReason — identity state is never invented for a
 * non-human sender.
 */
export type EmailActor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "system"; readonly reason: string };

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
