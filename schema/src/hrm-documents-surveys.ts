import {
  foreignKey,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";

export const hrmDocuments = pgTable(
  "hrm_documents",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id"),
    // Nullable: the anonymize retention action clears the party link
    // while the row and its events stay as deletion evidence.
    partyId: uuid("party_id"),
    templateId: uuid("template_id"),
    categoryKey: text("category_key").notNull(),
    title: text("title").notNull(),
    fileId: uuid("file_id"),
    status: text("status").notNull().default("draft"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    retentionRuleId: uuid("retention_rule_id"),
    retainUntil: date("retain_until"),
    legalHold: boolean("legal_hold").notNull().default(false),
    voidReason: text("void_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_documents_party_tenant_fkey",
      columns: [t.orgId, t.partyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    index("hrm_documents_org_party").on(t.orgId, t.partyId),
    index("hrm_documents_org_status").on(t.orgId, t.status),
    index("hrm_documents_retain_due").on(t.orgId, t.retainUntil),
  ],
);

export const hrmSurveys = pgTable(
  "hrm_surveys",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    anonymity: text("anonymity").notNull(),
    status: text("status").notNull().default("draft"),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    audience: jsonb("audience").notNull().default({}),
    recurrence: jsonb("recurrence"),
    minGroupSize: integer("min_group_size").notNull().default(5),
    ...auditColumns,
  },
  (t) => [index("hrm_surveys_org_status").on(t.orgId, t.status)],
);
