import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
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
