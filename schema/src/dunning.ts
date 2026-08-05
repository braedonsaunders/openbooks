import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Dunning — automated collections on overdue receivables. A policy is an
 * ordered ladder of stages; each stage fires once per open invoice when the
 * invoice crosses that stage's offset from its due date. Firing sends an email
 * (through the org's mail delivery) and writes an append-only dunning_log row.
 *
 * The runner (engine/src/dunning.ts) never posts to the ledger — collections is
 * a communications layer over the AR subledger, so it stays outside the kernel.
 */
export const dunningPolicies = pgTable(
  "dunning_policies",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    /** Only overdue documents of this kind are dunned. */
    appliesToKind: text("applies_to_kind").notNull().default("customer_invoice"),
    /** Days after the due date before the ladder is allowed to start. */
    gracePeriodDays: integer("grace_period_days").notNull().default(0),
    /** Minimum open balance (org base currency) below which no reminder is sent. */
    minBalance: money("min_balance").notNull().default("0"),
    /** Optional reply-to for the reminder emails. */
    replyTo: text("reply_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("dunning_policies_org_active").on(t.orgId, t.isActive)],
);

export const dunningStages = pgTable(
  "dunning_stages",
  {
    id: id(),
    orgId: orgRef(),
    policyId: uuid("policy_id").notNull(),
    /** Ladder position; stages fire in ascending order. */
    sequence: integer("sequence").notNull(),
    name: text("name").notNull(),
    /** Days past the due date at which this stage becomes due. Negative = a
     *  courtesy reminder issued BEFORE the due date. */
    offsetDays: integer("offset_days").notNull(),
    subjectTemplate: text("subject_template").notNull(),
    /** Mustache-style body with {{party}} {{invoice}} {{amount}} {{dueDate}}
     *  {{daysOverdue}} {{orgName}} tokens. */
    bodyTemplate: text("body_template").notNull(),
    /** Copy AR/collections owners on this and later stages. */
    escalate: boolean("escalate").notNull().default(false),
    ...auditColumns,
  },
  (t) => [uniqueIndex("dunning_stages_policy_seq").on(t.policyId, t.sequence)],
);

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
    status: text("status", { enum: ["sent", "failed", "skipped"] })
      .notNull()
      .default("sent"),
    detail: text("detail"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  // One row per (invoice, stage): the DB uniqueness is the idempotency guard
  // that stops a stage re-firing on the next scheduler tick.
  (t) => [
    uniqueIndex("dunning_log_document_stage").on(t.documentId, t.stageId),
    index("dunning_log_org_doc").on(t.orgId, t.documentId),
  ],
);
