import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs } from "./core";
import { files } from "./file-cabinet";
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";
import {
  applications,
  candidates,
  interviews,
  offers,
  pipelineStages,
  requisitions,
} from "./hrm-recruiting";

/**
 * HRM recruiting depth (migration 0229, HR-18).
 *
 * Interview kits + blind scorecards, candidate self-scheduling, template
 * offers with e-sign, job-board publishing with disposition sync, consent
 * + retention rules, talent pools.
 *
 * - hrm_interview_kits / hrm_scorecard_attributes /
 *   hrm_interview_kit_questions are CONFIGURATION: the org's structured
 *   interview vocabulary. A kit with sittings is history-pinned
 *   (RESTRICT); deactivate it instead of deleting it.
 * - hrm_scorecards / hrm_scorecard_ratings are VERDICTS: one scorecard per
 *   (interview, interviewer). Drafts stay editable; submitted verdicts are
 *   immutable except a pure audit touch (SQL trigger). The blind rule — an
 *   interviewer reads others' scorecards only after submitting their own —
 *   lives in the read service, which is the only layer that knows the
 *   reader.
 * - hrm_interview_slots are SCHEDULING rows: proposed/booked/declined per
 *   interview. One link covers a proposed batch, so the token SHA-256 hex
 *   repeats across the batch rows (indexed, not unique); the raw token is
 *   shown once and emailed, never stored.
 * - hrm_offer_templates are CONFIGURATION; hrm_offer_versions are
 *   append-only regeneration evidence (never an overwrite).
 * - hrm_job_postings are per (requisition, board_key);
 *   hrm_posting_events are append-only disposition evidence.
 * - hrm_retention_rules / hrm_retention_runs / hrm_candidate_consents own
 *   GDPR-as-a-setting: inactivity/consent basis, anonymize/delete action,
 *   one append-only run row per evaluation. Delete orphans application
 *   events as aggregates (SET NULL, documented in the migration header).
 * - hrm_talent_pools / hrm_talent_pool_members are rediscovery pools.
 * - Overlap-style guards that need storage-level safety (partial uniques,
 *   paired CHECKs, append-only and submitted-immutable triggers) live in
 *   the SQL migration; Drizzle has no partial-unique primitive.
 * - SQL-only edges (documented, not declared): kit-question attribute pin
 *   → hrm_scorecard_attributes(id) (single-column SET NULL, lineage not
 *   scope), event application link → hrm_applications(id) (single-column
 *   SET NULL, orphan-safe aggregates), the 0229 ALTER columns on 0195
 *   tables (interviews.kit_id, panel focus_attribute_ids,
 *   offers.template_id/rendered_file_id, applications.source_posting_id —
 *   declared in SQL only so the two drizzle mirrors never import each
 *   other), actor_id / created_by / updated_by / proposed_by / added_by →
 *   users(id) (RESTRICT frozen evidence, 0185 home-org pattern),
 *   terminal-immutability and no-delete triggers, and the files(org_id, id)
 *   covering unique.
 */

export const SCORECARD_RATINGS = ["strong_no", "no", "yes", "strong_yes"] as const;

export const SLOT_KINDS = ["proposed", "booked", "declined"] as const;

export const OFFER_SIGNATURE_STATUSES = [
  "unsigned",
  "sent",
  "viewed",
  "signed",
  "declined",
  "voided",
] as const;

export const POSTING_STATUSES = ["draft", "published", "paused", "closed", "error"] as const;

export const POSTING_EVENT_KINDS = [
  "published",
  "paused",
  "closed",
  "apply_received",
  "disposition_sent",
  "error",
] as const;

export const RETENTION_BASES = ["inactivity", "consent"] as const;

export const RETENTION_ACTIONS = ["anonymize", "delete"] as const;

export const CONSENT_PURPOSES = ["this_application", "future_roles", "talent_pool"] as const;

export const CONSENT_SOURCES = ["form", "email", "import"] as const;

/** Structured-interview kit: name, stage pin, instructions, rating scale. */
export const interviewKits = pgTable(
  "hrm_interview_kits",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    pipelineStageId: uuid("pipeline_stage_id"),
    instructions: text("instructions"),
    ratingScale: text("rating_scale").array().notNull().default(sql`'{strong_no,no,yes,strong_yes}'`),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_interview_kits_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_interview_kits_stage_tenant_fkey",
      columns: [t.orgId, t.pipelineStageId],
      foreignColumns: [pipelineStages.orgId, pipelineStages.id],
    }),
    uniqueIndex("hrm_interview_kits_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_interview_kits_org_name").on(t.orgId, t.name),
    index("hrm_interview_kits_stage").on(t.orgId, t.pipelineStageId),
    check("hrm_interview_kits_name_not_blank", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** Rated attributes of a kit, ordered by position. */
export const scorecardAttributes = pgTable(
  "hrm_scorecard_attributes",
  {
    id: id(),
    orgId: orgRef(),
    kitId: uuid("kit_id").notNull(),
    category: text("category").notNull(),
    attribute: text("attribute").notNull(),
    description: text("description"),
    position: integer("position").notNull(),
    isFocusDefault: boolean("is_focus_default").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_scorecard_attributes_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_scorecard_attributes_kit_tenant_fkey",
      columns: [t.orgId, t.kitId],
      foreignColumns: [interviewKits.orgId, interviewKits.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_scorecard_attributes_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_scorecard_attributes_org_kit_position").on(t.orgId, t.kitId, t.position),
    check("hrm_scorecard_attributes_position", sql`${t.position} >= 0`),
  ],
);

/** Suggested questions per kit, optionally pinned to one attribute. */
export const interviewKitQuestions = pgTable(
  "hrm_interview_kit_questions",
  {
    id: id(),
    orgId: orgRef(),
    kitId: uuid("kit_id").notNull(),
    question: text("question").notNull(),
    position: integer("position").notNull(),
    attributeId: uuid("attribute_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_interview_kit_questions_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_interview_kit_questions_kit_tenant_fkey",
      columns: [t.orgId, t.kitId],
      foreignColumns: [interviewKits.orgId, interviewKits.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_interview_kit_questions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_interview_kit_questions_org_kit_position").on(t.orgId, t.kitId, t.position),
    check("hrm_interview_kit_questions_position", sql`${t.position} >= 0`),
  ],
);

/** One verdict per (interview, interviewer). */
export const scorecards = pgTable(
  "hrm_scorecards",
  {
    id: id(),
    orgId: orgRef(),
    interviewId: uuid("interview_id").notNull(),
    interviewerPartyId: uuid("interviewer_party_id").notNull(),
    overall: text("overall", { enum: SCORECARD_RATINGS }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    privateNotes: text("private_notes"),
    sharedNotes: text("shared_notes"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_scorecards_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_scorecards_interview_tenant_fkey",
      columns: [t.orgId, t.interviewId],
      foreignColumns: [interviews.orgId, interviews.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_scorecards_party_tenant_fkey",
      columns: [t.orgId, t.interviewerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_scorecards_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_scorecards_org_interview_party").on(t.orgId, t.interviewId, t.interviewerPartyId),
    index("hrm_scorecards_interview").on(t.orgId, t.interviewId),
  ],
);

/** One rating per (scorecard, attribute). */
export const scorecardRatings = pgTable(
  "hrm_scorecard_ratings",
  {
    id: id(),
    orgId: orgRef(),
    scorecardId: uuid("scorecard_id").notNull(),
    attributeId: uuid("attribute_id").notNull(),
    ratingKey: text("rating_key", { enum: SCORECARD_RATINGS }).notNull(),
    note: text("note"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_scorecard_ratings_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_scorecard_ratings_scorecard_tenant_fkey",
      columns: [t.orgId, t.scorecardId],
      foreignColumns: [scorecards.orgId, scorecards.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_scorecard_ratings_attribute_tenant_fkey",
      columns: [t.orgId, t.attributeId],
      foreignColumns: [scorecardAttributes.orgId, scorecardAttributes.id],
    }),
    uniqueIndex("hrm_scorecard_ratings_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_scorecard_ratings_org_scorecard_attribute").on(
      t.orgId,
      t.scorecardId,
      t.attributeId,
    ),
    index("hrm_scorecard_ratings_scorecard").on(t.orgId, t.scorecardId),
  ],
);

/** Proposed/booked/declined scheduling rows per interview. */
export const interviewSlots = pgTable(
  "hrm_interview_slots",
  {
    id: id(),
    orgId: orgRef(),
    interviewId: uuid("interview_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    kind: text("kind", { enum: SLOT_KINDS }).notNull().default("proposed"),
    proposedBy: uuid("proposed_by"),
    bookedByCandidateAt: timestamp("booked_by_candidate_at", { withTimezone: true }),
    calendarRef: jsonb("calendar_ref"),
    candidateTokenHash: text("candidate_token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_interview_slots_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_interview_slots_interview_tenant_fkey",
      columns: [t.orgId, t.interviewId],
      foreignColumns: [interviews.orgId, interviews.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_interview_slots_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_interview_slots_token").on(t.orgId, t.candidateTokenHash),
    index("hrm_interview_slots_interview").on(t.orgId, t.interviewId, t.kind),
    index("hrm_interview_slots_upcoming").on(t.orgId, t.kind, t.startsAt),
  ],
);

/** Named interviewer groups with declared availability windows. */
export const interviewerPools = pgTable(
  "hrm_interviewer_pools",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    memberPartyIds: uuid("member_party_ids").array().notNull().default(sql`'{}'`),
    availability: jsonb("availability"),
    kitId: uuid("kit_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_interviewer_pools_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_interviewer_pools_kit_tenant_fkey",
      columns: [t.orgId, t.kitId],
      foreignColumns: [interviewKits.orgId, interviewKits.id],
    }),
    uniqueIndex("hrm_interviewer_pools_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_interviewer_pools_org_name").on(t.orgId, t.name),
    check("hrm_interviewer_pools_name_not_blank", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** Offer templates: mustache body plus clause rows. */
export const offerTemplates = pgTable(
  "hrm_offer_templates",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    bodyTemplate: text("body_template").notNull(),
    clauses: jsonb("clauses").notNull().default(sql`'[]'`),
    approvalRequired: boolean("approval_required").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_offer_templates_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_offer_templates_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_offer_templates_org_name").on(t.orgId, t.name),
    check("hrm_offer_templates_name_not_blank", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** Append-only offer regeneration evidence. */
export const offerVersions = pgTable(
  "hrm_offer_versions",
  {
    id: id(),
    orgId: orgRef(),
    offerId: uuid("offer_id").notNull(),
    version: integer("version").notNull(),
    payload: jsonb("payload").notNull(),
    renderedFileId: uuid("rendered_file_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    foreignKey({
      name: "hrm_offer_versions_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_offer_versions_offer_tenant_fkey",
      columns: [t.orgId, t.offerId],
      foreignColumns: [offers.orgId, offers.id],
    }),
    foreignKey({
      name: "hrm_offer_versions_rendered_file_tenant_fkey",
      columns: [t.orgId, t.renderedFileId],
      foreignColumns: [files.orgId, files.id],
    }),
    uniqueIndex("hrm_offer_versions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_offer_versions_org_offer_version").on(t.orgId, t.offerId, t.version),
    index("hrm_offer_versions_offer").on(t.orgId, t.offerId, t.version),
    check("hrm_offer_versions_version", sql`${t.version} >= 1`),
  ],
);

/** One posting per (requisition, board_key). */
export const jobPostings = pgTable(
  "hrm_job_postings",
  {
    id: id(),
    orgId: orgRef(),
    requisitionId: uuid("requisition_id").notNull(),
    boardKey: text("board_key").notNull(),
    externalRef: text("external_ref"),
    status: text("status", { enum: POSTING_STATUSES }).notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_job_postings_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_job_postings_requisition_tenant_fkey",
      columns: [t.orgId, t.requisitionId],
      foreignColumns: [requisitions.orgId, requisitions.id],
    }),
    uniqueIndex("hrm_job_postings_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_job_postings_org_requisition_board").on(t.orgId, t.requisitionId, t.boardKey),
    index("hrm_job_postings_requisition").on(t.orgId, t.requisitionId, t.status),
  ],
);

/** Append-only posting event ledger. */
export const postingEvents = pgTable(
  "hrm_posting_events",
  {
    id: id(),
    orgId: orgRef(),
    postingId: uuid("posting_id").notNull(),
    kind: text("kind", { enum: POSTING_EVENT_KINDS }).notNull(),
    payload: jsonb("payload"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "hrm_posting_events_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_posting_events_posting_tenant_fkey",
      columns: [t.orgId, t.postingId],
      foreignColumns: [jobPostings.orgId, jobPostings.id],
    }),
    uniqueIndex("hrm_posting_events_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_posting_events_posting").on(t.orgId, t.postingId, t.recordedAt),
  ],
);

/** Retention rules: region scope, basis, months, action. */
export const retentionRules = pgTable(
  "hrm_retention_rules",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    regionScope: jsonb("region_scope").notNull().default(sql`'{}'`),
    basis: text("basis", { enum: RETENTION_BASES }).notNull(),
    retainMonths: integer("retain_months").notNull(),
    action: text("action", { enum: RETENTION_ACTIONS }).notNull().default("anonymize"),
    consentExtensionLeadDays: integer("consent_extension_lead_days"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_retention_rules_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_retention_rules_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_retention_rules_org_name").on(t.orgId, t.name),
    check("hrm_retention_rules_retain_months", sql`${t.retainMonths} >= 1`),
  ],
);

/** Append-only retention run ledger. */
export const retentionRuns = pgTable(
  "hrm_retention_runs",
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid("rule_id").notNull(),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    candidatesAnonymized: integer("candidates_anonymized").notNull().default(0),
    candidatesDeleted: integer("candidates_deleted").notNull().default(0),
    extensionsRequested: integer("extensions_requested").notNull().default(0),
    detail: jsonb("detail"),
  },
  (t) => [
    foreignKey({
      name: "hrm_retention_runs_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_retention_runs_rule_tenant_fkey",
      columns: [t.orgId, t.ruleId],
      foreignColumns: [retentionRules.orgId, retentionRules.id],
    }),
    uniqueIndex("hrm_retention_runs_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_retention_runs_rule").on(t.orgId, t.ruleId, t.ranAt),
  ],
);

/** One consent row per (candidate, purpose). */
export const candidateConsents = pgTable(
  "hrm_candidate_consents",
  {
    id: id(),
    orgId: orgRef(),
    candidateId: uuid("candidate_id").notNull(),
    purpose: text("purpose", { enum: CONSENT_PURPOSES }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    extensionRequestedAt: timestamp("extension_requested_at", { withTimezone: true }),
    source: text("source", { enum: CONSENT_SOURCES }).notNull(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_candidate_consents_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_candidate_consents_candidate_tenant_fkey",
      columns: [t.orgId, t.candidateId],
      foreignColumns: [candidates.orgId, candidates.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_candidate_consents_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_candidate_consents_org_candidate_purpose").on(
      t.orgId,
      t.candidateId,
      t.purpose,
    ),
    index("hrm_candidate_consents_candidate").on(t.orgId, t.candidateId, t.purpose),
    index("hrm_candidate_consents_expiry").on(t.orgId, t.expiresAt),
  ],
);

/** Named talent pools for rediscovery. */
export const talentPools = pgTable(
  "hrm_talent_pools",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    description: text("description"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_talent_pools_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_talent_pools_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_talent_pools_org_name").on(t.orgId, t.name),
    check("hrm_talent_pools_name_not_blank", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** Pool membership: join rows between pools and candidates. */
export const talentPoolMembers = pgTable(
  "hrm_talent_pool_members",
  {
    id: id(),
    orgId: orgRef(),
    poolId: uuid("pool_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    addedBy: uuid("added_by"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (t) => [
    foreignKey({
      name: "hrm_talent_pool_members_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_talent_pool_members_pool_tenant_fkey",
      columns: [t.orgId, t.poolId],
      foreignColumns: [talentPools.orgId, talentPools.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_talent_pool_members_candidate_tenant_fkey",
      columns: [t.orgId, t.candidateId],
      foreignColumns: [candidates.orgId, candidates.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_talent_pool_members_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_talent_pool_members_pool_candidate").on(t.orgId, t.poolId, t.candidateId),
    index("hrm_talent_pool_members_pool").on(t.orgId, t.poolId),
    index("hrm_talent_pool_members_candidate").on(t.orgId, t.candidateId),
  ],
);
