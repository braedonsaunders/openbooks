import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { orgs } from "./core";
import { files } from "./file-cabinet";
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";
import {
  candidates,
  interviews,
  offers
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

export const POSTING_STATUSES = ["draft", "published", "paused", "closed", "error"] as const;

export const RETENTION_BASES = ["inactivity", "consent"] as const;

export const RETENTION_ACTIONS = ["anonymize", "delete"] as const;

export const CONSENT_PURPOSES = ["this_application", "future_roles", "talent_pool"] as const;

export const CONSENT_SOURCES = ["form", "email", "import"] as const;

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

    uniqueIndex("hrm_scorecard_ratings_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_scorecard_ratings_org_scorecard_attribute").on(
      t.orgId,
      t.scorecardId,
      t.attributeId,
    ),
    index("hrm_scorecard_ratings_scorecard").on(t.orgId, t.scorecardId),
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
