import {
  foreignKey,
  boolean,
  customType,
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
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";

/**
 * HRM documents with e-sign, retention, DSAR exports, surveys (migration
 * 0230, HR-19).
 *
 * - hrm_document_categories: the org-declared Setup vocabulary.
 * - hrm_document_templates / hrm_documents / hrm_document_signers /
 *   hrm_document_events: the hire-to-retire paper trail. Templates carry
 *   mustache bodies with declared merge fields; documents point at the
 *   current File Cabinet file (versions carry history); signers hold one
 *   consumable HMAC token each with the signing evidence record; events
 *   are the append-only ledger.
 * - hrm_retention_schedules / hrm_retention_actions: one rule per org
 *   category plus the append-only execution ledger (flag, grace, execute
 *   or legal-hold block).
 * - hrm_data_subject_exports: the DSAR queue; the worker builds the zip.
 * - hrm_surveys / hrm_survey_questions / hrm_survey_invitations /
 *   hrm_survey_responses: engagement and pulse surveys with the anonymity
 *   grade that decides what a response may store (anonymous = no link).
 *
 * Org chart needs no table: it reads reporting_relationships line edges
 * with position titles as of a date (engine/src/hrm/org-chart.ts).
 */

/** Postgres `bytea` passthrough (same shape as file-cabinet.ts): the
 * confidential respondent link is opaque encrypted bytes. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const hrmDocumentCategories = pgTable(
  "hrm_document_categories",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_document_categories_org_key").on(t.orgId, t.key),
  ],
);

export const hrmDocumentTemplates = pgTable(
  "hrm_document_templates",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    categoryKey: text("category_key").notNull(),
    bodyTemplate: text("body_template").notNull(),
    mergeFields: jsonb("merge_fields").notNull().default([]),
    requiresSignature: boolean("requires_signature").notNull().default(false),
    signerRoles: jsonb("signer_roles").notNull().default([]),
    acknowledgmentOnly: boolean("acknowledgment_only").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_document_templates_org_name").on(t.orgId, t.name),
    index("hrm_document_templates_org_category").on(t.orgId, t.categoryKey),
  ],
);

export const hrmRetentionSchedules = pgTable(
  "hrm_retention_schedules",
  {
    id: id(),
    orgId: orgRef(),
    categoryKey: text("category_key").notNull(),
    retainYears: integer("retain_years").notNull(),
    fromEvent: text("from_event").notNull(),
    action: text("action").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_retention_schedules_org_category").on(t.orgId, t.categoryKey),
  ],
);

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

export const hrmDocumentSigners = pgTable(
  "hrm_document_signers",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    ord: integer("ord").notNull(),
    signerPartyId: uuid("signer_party_id").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    evidence: jsonb("evidence"),
    declineReason: text("decline_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_document_signers_signer_party_tenant_fkey",
      columns: [t.orgId, t.signerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_document_signers_token_unique").on(t.tokenHash),
    uniqueIndex("hrm_document_signers_document_ord").on(t.documentId, t.ord),
    index("hrm_document_signers_org_signer").on(t.orgId, t.signerPartyId, t.status),
  ],
);

export const hrmDocumentEvents = pgTable(
  "hrm_document_events",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    kind: text("kind").notNull(),
    actor: uuid("actor"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hrm_document_events_document").on(t.orgId, t.documentId, t.recordedAt)],
);

export const hrmRetentionActions = pgTable(
  "hrm_retention_actions",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    scheduleId: uuid("schedule_id").notNull(),
    dueOn: date("due_on").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    action: text("action").notNull(),
    executedBy: uuid("executed_by"),
    blockedReason: text("blocked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("hrm_retention_actions_due").on(t.orgId, t.dueOn),
    index("hrm_retention_actions_document").on(t.orgId, t.documentId),
  ],
);

export const hrmDataSubjectExports = pgTable(
  "hrm_data_subject_exports",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("queued"),
    fileId: uuid("file_id"),
    scope: jsonb("scope").notNull().default([]),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_data_subject_exports_party_tenant_fkey",
      columns: [t.orgId, t.partyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    index("hrm_data_subject_exports_org_party").on(t.orgId, t.partyId, t.requestedAt),
    index("hrm_data_subject_exports_queued").on(t.orgId, t.requestedAt),
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

export const hrmSurveyQuestions = pgTable(
  "hrm_survey_questions",
  {
    id: id(),
    orgId: orgRef(),
    surveyId: uuid("survey_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    prompt: text("prompt").notNull(),
    options: jsonb("options").notNull().default([]),
    driverKey: text("driver_key"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_survey_questions_survey_position").on(t.surveyId, t.position),
    index("hrm_survey_questions_survey").on(t.orgId, t.surveyId),
  ],
);

export const hrmSurveyInvitations = pgTable(
  "hrm_survey_invitations",
  {
    id: id(),
    orgId: orgRef(),
    surveyId: uuid("survey_id").notNull(),
    partyId: uuid("party_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "hrm_survey_invitations_party_tenant_fkey",
      columns: [t.orgId, t.partyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_survey_invitations_token_unique").on(t.tokenHash),
    uniqueIndex("hrm_survey_invitations_survey_party").on(t.orgId, t.surveyId, t.partyId),
    index("hrm_survey_invitations_survey").on(t.orgId, t.surveyId),
    index("hrm_survey_invitations_party").on(t.orgId, t.partyId),
  ],
);

export const hrmSurveyResponses = pgTable(
  "hrm_survey_responses",
  {
    id: id(),
    orgId: orgRef(),
    surveyId: uuid("survey_id").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    respondentLinkEnc: bytea("respondent_link_enc"),
    segmentSnapshot: jsonb("segment_snapshot"),
    answers: jsonb("answers").notNull().default([]),
  },
  (t) => [index("hrm_survey_responses_survey").on(t.orgId, t.surveyId, t.submittedAt)],
);
