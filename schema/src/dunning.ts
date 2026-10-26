import {
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
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

export const dunningLog = pgTable(
  "dunning_log",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    stageId: uuid("stage_id").notNull(),
    partyId: uuid("party_id"),
    toEmail: text("to_email"),
    amountDue: money("amount_due").notNull().default("0"),
    currency: currencyCode(),
    channel: text("channel").notNull().default("email"),
    status: text("status", { enum: ["sent", "failed", "skipped", "staged", "suppressed"] })
      .notNull()
      .default("sent"),
    detail: text("detail"),
    // Delivery evidence only: NULL until a letter is actually delivered (the
    // email worker's staged→sent settle stamps it). Staged, suppressed and
    // failed claims keep NULL — a populated sent_at must always mean the
    // customer got the letter. Migration 0329 drops the old NOT NULL DEFAULT
    // now() that stamped every claim at claim time.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...auditColumns,
  },
  // One row per (invoice, stage): the DB uniqueness is the idempotency guard
  // that stops a stage re-firing on the next scheduler tick.
  (t) => [
    uniqueIndex("dunning_log_document_stage").on(t.documentId, t.stageId),
    index("dunning_log_org_doc").on(t.orgId, t.documentId),
  ],
);

/**
 * Batched customer statements: one run row records who created the batch,
 * when, for which period, and with which filters; one item row per
 * customer carries the resolved mailbox and the delivery state. Matches
 * migration 0650.
 */
export const statementBatchRuns = pgTable(
  "statement_batch_runs",
  {
    id: id(),
    orgId: orgRef(),
    periodFrom: date("period_from"),
    periodTo: date("period_to").notNull(),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
    recipientCount: integer("recipient_count").notNull().default(0),
    status: text("status", { enum: ["queued", "sending", "done"] })
      .notNull()
      .default("queued"),
    authorizationSnapshot: jsonb("authorization_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...auditColumns,
  },
  (t) => [index("statement_batch_runs_org_created").on(t.orgId, t.createdAt)],
);

export const statementBatchItems = pgTable(
  "statement_batch_items",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    partyId: uuid("party_id").notNull(),
    toEmail: text("to_email"),
    balance: money("balance").notNull().default("0"),
    overdue: money("overdue").notNull().default("0"),
    currency: currencyCode("currency_code"),
    status: text("status", { enum: ["queued", "sending", "sent", "failed", "skipped"] })
      .notNull()
      .default("queued"),
    error: text("error"),
    deliveryKey: text("delivery_key"),
    emailLogId: uuid("email_log_id"),
    // Delivery evidence only: NULL until the statement is actually
    // delivered. Queued, failed, and skipped items keep NULL — a populated
    // sent_at must always mean the customer got the statement.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...auditColumns,
  },
  // One row per (run, customer): the DB uniqueness is the idempotency guard
  // that stops a retried job from sending twice.
  (t) => [
    uniqueIndex("statement_batch_items_run_party_unique").on(t.runId, t.partyId),
    index("statement_batch_items_org_run").on(t.orgId, t.runId),
  ],
);
