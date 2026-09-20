import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { departments, locations, orgs } from "./core";
import { files } from "./file-cabinet";
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";
import { subsidiaries } from "./subsidiaries";
import { hrmEmploymentChangeRequests, workerEmployments } from "./hrm";
import { positions } from "./hrm-positions";

/**
 * HRM recruiting (migration 0195).
 *
 * A vacancy's path to a hire: a requisition opens against a position (or a
 * planned headcount), candidates move through a configurable pipeline with
 * recorded events, an accepted offer becomes the hire through the SAME
 * change-request and Flows path every other employment start uses, and the
 * requisition fills when its headcount is met.
 *
 * - hrm_pipeline_templates / hrm_pipeline_stages are CONFIGURATION: the
 *   org's own funnel, ordered rows with a stable key and a kind. Terminality
 *   derives from kind (hired/rejected), never an independent flag.
 * - hrm_requisitions / hrm_candidates / hrm_applications /
 *   hrm_application_events / hrm_interviews / hrm_interview_panel /
 *   hrm_offers are HISTORY: every transition appends an event in the same
 *   transaction as the state write; the event ledger is append-only on every
 *   path; terminal rows are immutable except a pure audit touch; deletes
 *   only on the governed amend path.
 * - Overlap-style concurrency guards that need storage-level safety (the
 *   one-default-per-org and one-live-offer-per-application partial uniques,
 *   the filled_count <= headcount bound, the terminal-immutability and
 *   no-delete triggers) live in the SQL migration; Drizzle has no
 *   partial-unique primitive.
 * - SQL-only edges (documented, not declared): event from/to stage lineage
 *   → hrm_pipeline_stages(id) (single-column SET NULL, lineage not scope),
 *   actor_id / recruiter_user_id / created_by / updated_by → users(id)
 *   (RESTRICT frozen evidence, 0185 home-org pattern), terminal-immutability
 *   and no-delete triggers, and the files(org_id, id) covering unique.
 */

export const PIPELINE_STAGE_KINDS = [
  "screening",
  "interview",
  "assessment",
  "offer",
  "hired",
  "rejected",
] as const;

export const REQUISITION_STATUSES = ["draft", "open", "on_hold", "filled", "cancelled"] as const;

export const CANDIDATE_SOURCES = [
  "referral",
  "job_board",
  "agency",
  "direct",
  "internal",
  "other",
] as const;

export const APPLICATION_STATUSES = ["active", "rejected", "withdrawn", "hired"] as const;

export const APPLICATION_EVENT_KINDS = [
  "applied",
  "stage_changed",
  "rejected",
  "withdrawn",
  "offer_created",
  "offer_sent",
  "offer_accepted",
  "offer_declined",
  "offer_withdrawn",
  "hired",
  "merged",
  "note",
] as const;

export const INTERVIEW_KINDS = ["phone", "video", "onsite", "panel", "assessment"] as const;

export const INTERVIEW_STATUSES = ["scheduled", "completed", "cancelled", "no_show"] as const;

export const INTERVIEW_OUTCOMES = ["advance", "hold", "reject"] as const;

export const OFFER_STATUSES = ["draft", "sent", "accepted", "declined", "withdrawn", "expired"] as const;

export const COMPENSATION_BASES = ["hourly", "annual"] as const;

/** The org's own funnel: one ordered pipeline per name, a single default. */
export const pipelineTemplates = pgTable(
  "hrm_pipeline_templates",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_pipeline_templates_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_pipeline_templates_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_pipeline_templates_org_name").on(t.orgId, t.name),
    index("hrm_pipeline_templates_org").on(t.orgId),
    check("hrm_pipeline_templates_name", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** Ordered funnel rows: stable key plus kind; terminality derives from kind. */
export const pipelineStages = pgTable(
  "hrm_pipeline_stages",
  {
    id: id(),
    orgId: orgRef(),
    templateId: uuid("template_id").notNull(),
    position: integer("position").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    statusKind: text("kind", { enum: PIPELINE_STAGE_KINDS }).notNull(),
    isTerminal: boolean("is_terminal").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_pipeline_stages_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_pipeline_stages_template_tenant_fkey",
      columns: [t.orgId, t.templateId],
      foreignColumns: [pipelineTemplates.orgId, pipelineTemplates.id],
    }).onDelete("cascade"),
    uniqueIndex("hrm_pipeline_stages_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_pipeline_stages_org_template_position").on(t.orgId, t.templateId, t.position),
    uniqueIndex("hrm_pipeline_stages_org_template_key").on(t.orgId, t.templateId, t.key),
    index("hrm_pipeline_stages_template").on(t.orgId, t.templateId, t.position),
    check("hrm_pipeline_stages_position", sql`${t.position} >= 0`),
    check("hrm_pipeline_stages_key", sql`char_length(btrim(${t.key})) > 0`),
    check("hrm_pipeline_stages_name", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** The vacancy to fill: org-sequence number, headcount versus filled_count. */
export const requisitions = pgTable(
  "hrm_requisitions",
  {
    id: id(),
    orgId: orgRef(),
    requisitionNumber: text("requisition_number").notNull(),
    positionId: uuid("position_id"),
    title: text("title").notNull(),
    employerSubsidiaryId: uuid("employer_subsidiary_id").notNull(),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    hiringManagerPartyId: uuid("hiring_manager_party_id"),
    recruiterUserId: uuid("recruiter_user_id"),
    headcount: integer("headcount").notNull(),
    filledCount: integer("filled_count").notNull().default(0),
    employmentKind: text("employment_kind"),
    targetStartOn: date("target_start_on"),
    compensationMin: numeric("compensation_min"),
    compensationMax: numeric("compensation_max"),
    compensationCurrency: text("compensation_currency"),
    compensationBasis: text("compensation_basis", { enum: COMPENSATION_BASES }),
    status: text("status", { enum: REQUISITION_STATUSES }).notNull().default("draft"),
    openedOn: date("opened_on"),
    closedOn: date("closed_on"),
    closeReason: text("close_reason"),
    pipelineTemplateId: uuid("pipeline_template_id"),
    description: text("description"),
    revision: integer("revision").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_requisitions_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_requisitions_position_tenant_fkey",
      columns: [t.orgId, t.positionId],
      foreignColumns: [positions.orgId, positions.id],
    }),
    foreignKey({
      name: "hrm_requisitions_employer_tenant_fkey",
      columns: [t.orgId, t.employerSubsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "hrm_requisitions_department_tenant_fkey",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
    }),
    foreignKey({
      name: "hrm_requisitions_location_tenant_fkey",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    foreignKey({
      name: "hrm_requisitions_manager_tenant_fkey",
      columns: [t.orgId, t.hiringManagerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "hrm_requisitions_template_tenant_fkey",
      columns: [t.orgId, t.pipelineTemplateId],
      foreignColumns: [pipelineTemplates.orgId, pipelineTemplates.id],
    }),
    uniqueIndex("hrm_requisitions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_requisitions_org_number").on(t.orgId, t.requisitionNumber),
    index("hrm_requisitions_status").on(t.orgId, t.status),
    index("hrm_requisitions_position").on(t.orgId, t.positionId),
    index("hrm_requisitions_manager").on(t.orgId, t.hiringManagerPartyId),
    check("hrm_requisitions_headcount", sql`${t.headcount} >= 1`),
    check("hrm_requisitions_filled_count", sql`${t.filledCount} >= 0`),
    check("hrm_requisitions_filled_bounded", sql`${t.filledCount} <= ${t.headcount}`),
    check("hrm_requisitions_revision", sql`${t.revision} >= 1`),
  ],
);

/**
 * The prospect before they are a party: a name plus contact PII, masked in
 * sandboxes like parties. party_id is set ONLY by hire.
 */
export const candidates = pgTable(
  "hrm_candidates",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id"),
    displayName: text("display_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    source: text("source", { enum: CANDIDATE_SOURCES }),
    sourceDetail: text("source_detail"),
    resumeAttachmentId: uuid("resume_attachment_id"),
    consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }),
    isInternal: boolean("is_internal").notNull().default(false),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_candidates_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_candidates_party_tenant_fkey",
      columns: [t.orgId, t.partyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "hrm_candidates_resume_tenant_fkey",
      columns: [t.orgId, t.resumeAttachmentId],
      foreignColumns: [files.orgId, files.id],
    }),
    uniqueIndex("hrm_candidates_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_candidates_email").on(t.orgId, t.email),
    check("hrm_candidates_name_not_blank", sql`char_length(btrim(${t.displayName})) > 0`),
  ],
);

/** One candidacy per (requisition, candidate) with the current funnel stage. */
export const applications = pgTable(
  "hrm_applications",
  {
    id: id(),
    orgId: orgRef(),
    requisitionId: uuid("requisition_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    stageId: uuid("stage_id").notNull(),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("active"),
    appliedOn: date("applied_on").notNull(),
    rejectedReason: text("rejected_reason"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    hiredEmploymentId: uuid("hired_employment_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_applications_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_applications_requisition_tenant_fkey",
      columns: [t.orgId, t.requisitionId],
      foreignColumns: [requisitions.orgId, requisitions.id],
    }),
    foreignKey({
      name: "hrm_applications_candidate_tenant_fkey",
      columns: [t.orgId, t.candidateId],
      foreignColumns: [candidates.orgId, candidates.id],
    }),
    foreignKey({
      name: "hrm_applications_stage_tenant_fkey",
      columns: [t.orgId, t.stageId],
      foreignColumns: [pipelineStages.orgId, pipelineStages.id],
    }),
    foreignKey({
      name: "hrm_applications_hired_employment_tenant_fkey",
      columns: [t.orgId, t.hiredEmploymentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    uniqueIndex("hrm_applications_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_applications_org_requisition_candidate").on(
      t.orgId,
      t.requisitionId,
      t.candidateId,
    ),
    index("hrm_applications_requisition").on(t.orgId, t.requisitionId, t.status),
    index("hrm_applications_candidate").on(t.orgId, t.candidateId),
    index("hrm_applications_stage").on(t.orgId, t.stageId),
  ],
);

/**
 * The append-only funnel evidence ledger. Every transition appends an event
 * in the same transaction as the state write; updates and deletes are
 * refused on every path by the SQL trigger.
 */
export const applicationEvents = pgTable(
  "hrm_application_events",
  {
    id: id(),
    orgId: orgRef(),
    applicationId: uuid("application_id").notNull(),
    kind: text("kind", { enum: APPLICATION_EVENT_KINDS }).notNull(),
    fromStageId: uuid("from_stage_id"),
    toStageId: uuid("to_stage_id"),
    reason: text("reason"),
    actorId: uuid("actor_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "hrm_application_events_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_application_events_application_tenant_fkey",
      columns: [t.orgId, t.applicationId],
      foreignColumns: [applications.orgId, applications.id],
    }),
    uniqueIndex("hrm_application_events_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_application_events_application").on(t.orgId, t.applicationId, t.recordedAt),
  ],
);

/** One interview sitting per row; the outcome is the completion verdict. */
export const interviews = pgTable(
  "hrm_interviews",
  {
    id: id(),
    orgId: orgRef(),
    applicationId: uuid("application_id").notNull(),
    kind: text("kind", { enum: INTERVIEW_KINDS }).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes"),
    location: text("location"),
    status: text("status", { enum: INTERVIEW_STATUSES }).notNull().default("scheduled"),
    outcome: text("outcome", { enum: INTERVIEW_OUTCOMES }),
    feedback: text("feedback"),
    scorecard: jsonb("scorecard"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_interviews_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_interviews_application_tenant_fkey",
      columns: [t.orgId, t.applicationId],
      foreignColumns: [applications.orgId, applications.id],
    }),
    uniqueIndex("hrm_interviews_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_interviews_application").on(t.orgId, t.applicationId, t.scheduledAt),
    index("hrm_interviews_upcoming").on(t.orgId, t.status, t.scheduledAt),
    check("hrm_interviews_duration", sql`${t.durationMinutes} IS NULL OR ${t.durationMinutes} > 0`),
  ],
);

/** Panel membership: join rows between interviews and parties. */
export const interviewPanel = pgTable(
  "hrm_interview_panel",
  {
    id: id(),
    orgId: orgRef(),
    interviewId: uuid("interview_id").notNull(),
    partyId: uuid("party_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_interview_panel_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_interview_panel_interview_tenant_fkey",
      columns: [t.orgId, t.interviewId],
      foreignColumns: [interviews.orgId, interviews.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_interview_panel_party_tenant_fkey",
      columns: [t.orgId, t.partyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_interview_panel_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_interview_panel_org_interview_party").on(t.orgId, t.interviewId, t.partyId),
    index("hrm_interview_panel_interview").on(t.orgId, t.interviewId),
  ],
);

/**
 * The proposed terms. At most one live (draft/sent) offer per application
 * (partial unique index in SQL); terminal rows immutable except an audit
 * touch; expiry computed on read, materialised on the next write.
 */
export const offers = pgTable(
  "hrm_offers",
  {
    id: id(),
    orgId: orgRef(),
    applicationId: uuid("application_id").notNull(),
    positionId: uuid("position_id"),
    employerSubsidiaryId: uuid("employer_subsidiary_id").notNull(),
    departmentId: uuid("department_id"),
    jobTitle: text("job_title").notNull(),
    employmentKind: text("employment_kind"),
    proposedStartOn: date("proposed_start_on").notNull(),
    compensationAmount: numeric("compensation_amount").notNull(),
    compensationCurrency: text("compensation_currency").notNull(),
    compensationBasis: text("compensation_basis", { enum: COMPENSATION_BASES }).notNull(),
    status: text("status", { enum: OFFER_STATUSES }).notNull().default("draft"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    expiresOn: date("expires_on"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    approvedChangeId: uuid("approved_change_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_offers_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hrm_offers_application_tenant_fkey",
      columns: [t.orgId, t.applicationId],
      foreignColumns: [applications.orgId, applications.id],
    }),
    foreignKey({
      name: "hrm_offers_position_tenant_fkey",
      columns: [t.orgId, t.positionId],
      foreignColumns: [positions.orgId, positions.id],
    }),
    foreignKey({
      name: "hrm_offers_employer_tenant_fkey",
      columns: [t.orgId, t.employerSubsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "hrm_offers_department_tenant_fkey",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
    }),
    foreignKey({
      name: "hrm_offers_approved_change_tenant_fkey",
      columns: [t.orgId, t.approvedChangeId],
      foreignColumns: [hrmEmploymentChangeRequests.orgId, hrmEmploymentChangeRequests.id],
    }),
    uniqueIndex("hrm_offers_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_offers_application").on(t.orgId, t.applicationId, t.status),
    index("hrm_offers_expiry").on(t.orgId, t.status, t.expiresOn),
    check("hrm_offers_title_not_blank", sql`char_length(btrim(${t.jobTitle})) > 0`),
    check("hrm_offers_compensation_amount", sql`${t.compensationAmount} > 0`),
  ],
);
