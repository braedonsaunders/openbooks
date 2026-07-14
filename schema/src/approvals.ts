import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Generic approval engine. The extraction shows approvals ARE the operational
 * backbone (bill → controller → payment authorization; expense reports;
 * journal approval; bank-detail changes) implemented as 18 tangled NetSuite
 * workflows plus per-person saved-search worklists ("Payments to Approve -
 * Kevin"). Here: policies declare routing; requests/steps are the runtime;
 * worklists are a single query.
 */
export const approvalPolicies = pgTable("approval_policies", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(),
  /** What this policy governs: a document kind or a table name. */
  targetKind: text("target_kind").notNull(), // "vendor_bill", "party_bank_accounts", …
  /** Ordered rule list: [{minAmount, approverPartyId | approverRole, step}] */
  rules: jsonb("rules").notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: id(),
    orgId: orgRef(),
    policyId: uuid("policy_id").notNull(),
    /** Polymorphic target: the document or record awaiting approval. */
    targetKind: text("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    amount: money("amount"), // routing input, snapshot at submission
    status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] })
      .notNull()
      .default("pending"),
    currentStep: integer("current_step").notNull().default(1),
    submittedBy: uuid("submitted_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("approval_requests_target").on(t.targetKind, t.targetId),
    index("approval_requests_status").on(t.orgId, t.status),
  ],
);

export const approvalSteps = pgTable(
  "approval_steps",
  {
    id: id(),
    orgId: orgRef(),
    requestId: uuid("request_id").notNull(),
    stepNumber: integer("step_number").notNull(),
    assigneePartyId: uuid("assignee_party_id"), // person…
    assigneeRole: text("assignee_role"), // …or role (controller, cfo)
    decision: text("decision", { enum: ["pending", "approved", "rejected", "skipped"] })
      .notNull()
      .default("pending"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    note: text("note"), // rejection reason — was custbody "Rejection Note"
    isDelegated: boolean("is_delegated").notNull().default(false),
    ...auditColumns,
  },
  (t) => [index("approval_steps_request").on(t.requestId)],
);
