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
import { orgs } from "./core";
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";
import { employmentChanges, workerEmployments } from "./hrm";

/**
 * HRM performance reviews, goals, and retention (migration 0196, HR-7).
 *
 * Employment records, positions and checklists exist; nothing records how
 * people are doing or why they leave. Reviews are a cycle the org runs
 * (templates, self and manager assessments, calibration, sharing,
 * acknowledgement) with the privacy model built in from the first row: a
 * review is visible to its subject only when shared, to the manager through
 * reporting_relationships, and to HR through the grant. Retention is the
 * exit record plus attrition figures derived from employment history.
 *
 * - hrm_review_templates / _sections / _questions are CONFIGURATION: the
 *   review form per org, editable through the Setup registry. The rating
 *   scale is {min, max, labels[]} pinned by the shape CHECK below; the
 *   Setup drawer edits it as structured min/max/labels fields (never raw
 *   JSON — registry.test.ts bars json-kind workforce fields), folded into
 *   rating_scale before buildRow (see web/lib/setup/hrm-review-template.ts
 *   and the integrity proof in web/lib/setup/write.ts).
 * - hrm_review_cycles / hrm_reviews / hrm_review_answers are HISTORY: a
 *   cycle opening instantiates self + manager reviews in ONE transaction,
 *   copying the template sections/questions into answer rows, so later
 *   template edits never rewrite an open cycle. applies_to carries the
 *   same {employer_subsidiary_id, department_id} shape CHECK as
 *   hrm_process_templates; cycles are created through the service (never
 *   the Setup drawer), so no STORED GENERATED slot projections exist here
 *   by design — the sandbox clone remaps applies_to through
 *   remapScopeFilter (hrm_review_cycles is registered in
 *   SCOPE_FILTER_TABLES), and structured surfaces read cycles through the
 *   performance read service.
 * - Calibration never overwrites: calibrated_rating sits beside the
 *   original overall_rating with its reason.
 * - hrm_review_events / hrm_goal_updates are append-only evidence (the
 *   refuse-update trigger in the SQL migration); corrections are new rows.
 * - hrm_goals are per-employment intentions with progress; hrm_exit_records
 *   are the exit record for terminated employments (one per employment).
 * - Deletes: submitted-or-later reviews, events, goal updates and exit
 *   records are retained history; pure-draft cycles and draft reviews may
 *   be discarded. The governed amend path (openbooks.amend, fixture
 *   teardown / sandbox wipe, org purge) is honoured so a review row can
 *   never pin its organisation; production paths never set that GUC.
 * - SQL-only edges (documented, not declared): created_by / updated_by /
 *   recorded_by / done actors → users(id) (0185 home-org pattern),
 *   terminal-immutability and no-delete triggers, the open-cycle partial
 *   unique, and the files/org covering uniques. Drizzle has no
 *   partial-unique primitive.
 */

export const REVIEW_TEMPLATE_SECTION_KINDS = ["competency", "goals", "free_text"] as const;
export const REVIEW_TEMPLATE_QUESTION_KINDS = ["rating", "text", "rating_and_text"] as const;
export const REVIEW_CYCLE_STATUSES = ["draft", "open", "calibrating", "closed"] as const;
export const REVIEW_KINDS = ["self", "manager", "peer"] as const;
export const REVIEW_STATUSES = ["pending", "submitted", "calibrated", "shared", "acknowledged"] as const;
export const REVIEW_EVENT_KINDS = [
  "instantiated",
  "submitted",
  "calibrated",
  "shared",
  "acknowledged",
  "reopened",
] as const;
export const GOAL_STATUSES = ["active", "achieved", "missed", "cancelled"] as const;
export const EXIT_REASON_KINDS = [
  "resignation",
  "retirement",
  "end_of_contract",
  "dismissal",
  "redundancy",
  "mutual",
  "death",
  "other",
] as const;

/** Native subject kinds if reviews/goals ever ride Flows; reserved, unused in 0196. */
export const HRM_REVIEW_SUBJECT_KIND = "hrm_review";
export const HRM_GOAL_SUBJECT_KIND = "hrm_goal";

/** Review form configuration: name, active flag, and the rating scale. */
export const hrmReviewTemplates = pgTable(
  "hrm_review_templates",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    /**
     * Rating scale: {"min": number, "max": number, "labels": string[]}.
     * Shape-pinned by hrm_review_templates_scale_shape; the Setup drawer
     * edits min/max/labels as structured fields folded into this object.
     */
    ratingScale: jsonb("rating_scale").notNull().default({ min: 1, max: 5, labels: [] }),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_review_templates_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    uniqueIndex("hrm_review_templates_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_review_templates_org_name").on(t.orgId, t.name),
    check("hrm_review_templates_name", sql`char_length(btrim(${t.name})) > 0`),
    check(
      "hrm_review_templates_scale_shape",
      sql`jsonb_typeof(${t.ratingScale}) = 'object'
          and (${t.ratingScale} ? 'min') and (${t.ratingScale} ? 'max')
          and jsonb_typeof(${t.ratingScale} -> 'min') = 'number'
          and jsonb_typeof(${t.ratingScale} -> 'max') = 'number'
          and ((${t.ratingScale} ->> 'min')::numeric < (${t.ratingScale} ->> 'max')::numeric)
          and ((${t.ratingScale} ->> 'max')::numeric - (${t.ratingScale} ->> 'min')::numeric) <= 99
          and (not (${t.ratingScale} ? 'labels') or jsonb_typeof(${t.ratingScale} -> 'labels') = 'array')`,
    ),
  ],
);

/** One ordered section of a review template. */
export const hrmReviewTemplateSections = pgTable(
  "hrm_review_template_sections",
  {
    id: id(),
    orgId: orgRef(),
    templateId: uuid("template_id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    /** Section weight, exact decimal (never float); sections need not sum to 1. */
    weight: numeric("weight", { precision: 19, scale: 4 }),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_review_template_sections_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_review_template_sections_template_tenant_fkey",
      columns: [t.orgId, t.templateId],
      foreignColumns: [hrmReviewTemplates.orgId, hrmReviewTemplates.id],
    }),
    uniqueIndex("hrm_review_template_sections_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_review_template_sections_org_template_position").on(
      t.orgId,
      t.templateId,
      t.position,
    ),
    index("hrm_review_template_sections_template").on(t.orgId, t.templateId, t.position),
    check("hrm_review_template_sections_kind", sql`${t.kind} in ('competency', 'goals', 'free_text')`),
    check("hrm_review_template_sections_title", sql`char_length(btrim(${t.title})) > 0`),
    check("hrm_review_template_sections_position", sql`${t.position} >= 0`),
    check("hrm_review_template_sections_weight", sql`${t.weight} is null or ${t.weight} >= 0`),
  ],
);

/** One prompt inside a template section. */
export const hrmReviewTemplateQuestions = pgTable(
  "hrm_review_template_questions",
  {
    id: id(),
    orgId: orgRef(),
    sectionId: uuid("section_id").notNull(),
    position: integer("position").notNull(),
    prompt: text("prompt").notNull(),
    answerKind: text("answer_kind").notNull(),
    required: boolean("required").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_review_template_questions_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_review_template_questions_section_tenant_fkey",
      columns: [t.orgId, t.sectionId],
      foreignColumns: [hrmReviewTemplateSections.orgId, hrmReviewTemplateSections.id],
    }),
    uniqueIndex("hrm_review_template_questions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_review_template_questions_org_section_position").on(
      t.orgId,
      t.sectionId,
      t.position,
    ),
    index("hrm_review_template_questions_section").on(t.orgId, t.sectionId, t.position),
    check("hrm_review_template_questions_prompt", sql`char_length(btrim(${t.prompt})) > 0`),
    check("hrm_review_template_questions_position", sql`${t.position} >= 0`),
    check(
      "hrm_review_template_questions_answer_kind",
      sql`${t.answerKind} in ('rating', 'text', 'rating_and_text')`,
    ),
  ],
);

/** A review run over a period: draft → open → calibrating → closed. */
export const hrmReviewCycles = pgTable(
  "hrm_review_cycles",
  {
    id: id(),
    orgId: orgRef(),
    templateId: uuid("template_id").notNull(),
    name: text("name").notNull(),
    periodStartOn: date("period_start_on").notNull(),
    periodEndOn: date("period_end_on").notNull(),
    selfDueOn: date("self_due_on"),
    managerDueOn: date("manager_due_on"),
    status: text("status").notNull().default("draft"),
    /**
     * Scope filter: {employer_subsidiary_id, department_id}, each a uuid
     * string or null; absent/null = whole org. Shape-pinned exactly like
     * hrm_process_templates (the CHECK is the single authority).
     */
    appliesTo: jsonb("applies_to").notNull().default({}),
    /** Employments in scope with no resolvable manager at open time. */
    managerGapCount: integer("manager_gap_count").notNull().default(0),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_review_cycles_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_review_cycles_template_tenant_fkey",
      columns: [t.orgId, t.templateId],
      foreignColumns: [hrmReviewTemplates.orgId, hrmReviewTemplates.id],
    }),
    uniqueIndex("hrm_review_cycles_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_review_cycles_status").on(t.orgId, t.status),
    check("hrm_review_cycles_name", sql`char_length(btrim(${t.name})) > 0`),
    check("hrm_review_cycles_status", sql`${t.status} in ('draft', 'open', 'calibrating', 'closed')`),
    check("hrm_review_cycles_period", sql`${t.periodEndOn} >= ${t.periodStartOn}`),
    check(
      "hrm_review_cycles_opened_paired",
      sql`(${t.status} in ('open', 'calibrating', 'closed')) = (${t.openedAt} is not null)`,
    ),
    check(
      "hrm_review_cycles_closed_paired",
      sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`,
    ),
    check("hrm_review_cycles_gap_count", sql`${t.managerGapCount} >= 0`),
    check(
      "hrm_review_cycles_applies_shape",
      sql`jsonb_typeof(${t.appliesTo}) = 'object'
          and (${t.appliesTo} - 'employer_subsidiary_id' - 'department_id') = '{}'::jsonb
          and (not (${t.appliesTo} ? 'employer_subsidiary_id')
               or jsonb_typeof(${t.appliesTo} -> 'employer_subsidiary_id') = 'null'
               or (jsonb_typeof(${t.appliesTo} -> 'employer_subsidiary_id') = 'string'
                   and ${t.appliesTo} ->> 'employer_subsidiary_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
          and (not (${t.appliesTo} ? 'department_id')
               or jsonb_typeof(${t.appliesTo} -> 'department_id') = 'null'
               or (jsonb_typeof(${t.appliesTo} -> 'department_id') = 'string'
                   and ${t.appliesTo} ->> 'department_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))`,
    ),
    check(
      "hrm_review_cycles_finite_time",
      sql`${t.periodStartOn} between date '0001-01-01' and date '9999-12-31'
          and ${t.periodEndOn} between date '0001-01-01' and date '9999-12-31'
          and (${t.selfDueOn} is null or ${t.selfDueOn} between date '0001-01-01' and date '9999-12-31')
          and (${t.managerDueOn} is null or ${t.managerDueOn} between date '0001-01-01' and date '9999-12-31')
          and (${t.openedAt} is null
               or (${t.openedAt} >= timestamptz '0001-01-01 00:00:00+00'
                   and ${t.openedAt} < timestamptz '10000-01-01 00:00:00+00'))
          and (${t.closedAt} is null
               or (${t.closedAt} >= timestamptz '0001-01-01 00:00:00+00'
                   and ${t.closedAt} < timestamptz '10000-01-01 00:00:00+00'))`,
    ),
  ],
);

/** One assessment: a self, manager, or peer review of an employment in a cycle. */
export const hrmReviews = pgTable(
  "hrm_reviews",
  {
    id: id(),
    orgId: orgRef(),
    cycleId: uuid("cycle_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    subjectPartyId: uuid("subject_party_id").notNull(),
    reviewerPartyId: uuid("reviewer_party_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    /** Author's rating; never overwritten by calibration (see calibratedRating). */
    overallRating: numeric("overall_rating", { precision: 19, scale: 4 }),
    /** HR calibration beside the original, with its reason. */
    calibratedRating: numeric("calibrated_rating", { precision: 19, scale: 4 }),
    calibrationReason: text("calibration_reason"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_reviews_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_reviews_cycle_tenant_fkey",
      columns: [t.orgId, t.cycleId],
      foreignColumns: [hrmReviewCycles.orgId, hrmReviewCycles.id],
    }),
    foreignKey({
      name: "hrm_reviews_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "hrm_reviews_subject_tenant_fkey",
      columns: [t.orgId, t.subjectPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "hrm_reviews_reviewer_tenant_fkey",
      columns: [t.orgId, t.reviewerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_reviews_org_id_id_unique").on(t.orgId, t.id),
    // One review per (cycle, employment, kind, reviewer): concurrent
    // instantiation serializes instead of duplicating.
    uniqueIndex("hrm_reviews_org_cycle_employment_kind_reviewer").on(
      t.orgId,
      t.cycleId,
      t.employmentId,
      t.kind,
      t.reviewerPartyId,
    ),
    index("hrm_reviews_cycle").on(t.orgId, t.cycleId, t.status),
    index("hrm_reviews_subject").on(t.orgId, t.subjectPartyId, t.status),
    index("hrm_reviews_employment").on(t.orgId, t.employmentId, t.kind),
    check("hrm_reviews_kind", sql`${t.kind} in ('self', 'manager', 'peer')`),
    check(
      "hrm_reviews_status",
      sql`${t.status} in ('pending', 'submitted', 'calibrated', 'shared', 'acknowledged')`,
    ),
    check(
      "hrm_reviews_submitted_paired",
      sql`(${t.status} in ('submitted', 'calibrated', 'shared', 'acknowledged')) = (${t.submittedAt} is not null)`,
    ),
    check(
      "hrm_reviews_shared_paired",
      sql`(${t.status} in ('shared', 'acknowledged')) = (${t.sharedAt} is not null)`,
    ),
    check(
      "hrm_reviews_acknowledged_paired",
      sql`(${t.status} = 'acknowledged') = (${t.acknowledgedAt} is not null)`,
    ),
    check(
      "hrm_reviews_calibrated_paired",
      sql`(${t.calibratedRating} is null) or (${t.calibrationReason} is not null and char_length(btrim(${t.calibrationReason})) > 0)`,
    ),
    check(
      "hrm_reviews_ratings_non_negative",
      sql`(${t.overallRating} is null or ${t.overallRating} >= 0) and (${t.calibratedRating} is null or ${t.calibratedRating} >= 0)`,
    ),
  ],
);

/** Snapshot answer rows of one review, copied from the template at instantiation. */
export const hrmReviewAnswers = pgTable(
  "hrm_review_answers",
  {
    id: id(),
    orgId: orgRef(),
    reviewId: uuid("review_id").notNull(),
    /** Snapshot of the template section title at instantiation. */
    sectionTitle: text("section_title").notNull(),
    /** Snapshot of the template question prompt at instantiation. */
    questionPrompt: text("question_prompt"),
    position: integer("position").notNull(),
    answerKind: text("answer_kind").notNull(),
    rating: numeric("rating", { precision: 19, scale: 4 }),
    text: text("text"),
    required: boolean("required").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_review_answers_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_review_answers_review_tenant_fkey",
      columns: [t.orgId, t.reviewId],
      foreignColumns: [hrmReviews.orgId, hrmReviews.id],
    }),
    uniqueIndex("hrm_review_answers_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_review_answers_org_review_position").on(t.orgId, t.reviewId, t.position),
    index("hrm_review_answers_review").on(t.orgId, t.reviewId, t.position),
    check("hrm_review_answers_title", sql`char_length(btrim(${t.sectionTitle})) > 0`),
    check("hrm_review_answers_position", sql`${t.position} >= 0`),
    check(
      "hrm_review_answers_kind",
      sql`${t.answerKind} in ('rating', 'text', 'rating_and_text')`,
    ),
    check("hrm_review_answers_rating", sql`${t.rating} is null or ${t.rating} >= 0`),
  ],
);

/** Append-only review lifecycle evidence. */
export const hrmReviewEvents = pgTable(
  "hrm_review_events",
  {
    id: id(),
    orgId: orgRef(),
    reviewId: uuid("review_id").notNull(),
    kind: text("kind").notNull(),
    actorUserId: uuid("actor_user_id"),
    reason: text("reason"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "hrm_review_events_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_review_events_review_tenant_fkey",
      columns: [t.orgId, t.reviewId],
      foreignColumns: [hrmReviews.orgId, hrmReviews.id],
    }),
    uniqueIndex("hrm_review_events_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_review_events_review").on(t.orgId, t.reviewId, t.recordedAt),
    check(
      "hrm_review_events_kind",
      sql`${t.kind} in ('instantiated', 'submitted', 'calibrated', 'shared', 'acknowledged', 'reopened')`,
    ),
  ],
);

/** Per-employment goals with progress. */
export const hrmGoals = pgTable(
  "hrm_goals",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    dueOn: date("due_on"),
    /** Goal weight, exact decimal (never float). */
    weight: numeric("weight", { precision: 19, scale: 4 }),
    status: text("status").notNull().default("active"),
    progressPercent: integer("progress_percent").notNull().default(0),
    /** Owning cycle when the goal was set inside a review cycle. */
    cycleId: uuid("cycle_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_goals_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_goals_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "hrm_goals_cycle_tenant_fkey",
      columns: [t.orgId, t.cycleId],
      foreignColumns: [hrmReviewCycles.orgId, hrmReviewCycles.id],
    }),
    uniqueIndex("hrm_goals_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_goals_employment").on(t.orgId, t.employmentId, t.status),
    index("hrm_goals_cycle").on(t.orgId, t.cycleId),
    check("hrm_goals_title", sql`char_length(btrim(${t.title})) > 0`),
    check("hrm_goals_status", sql`${t.status} in ('active', 'achieved', 'missed', 'cancelled')`),
    check(
      "hrm_goals_progress",
      sql`${t.progressPercent} >= 0 and ${t.progressPercent} <= 100`,
    ),
    check("hrm_goals_weight", sql`${t.weight} is null or ${t.weight} >= 0`),
    check(
      "hrm_goals_terminal_progress",
      sql`(${t.status} <> 'achieved') or ${t.progressPercent} = 100`,
    ),
  ],
);

/** Append-only goal progress evidence. */
export const hrmGoalUpdates = pgTable(
  "hrm_goal_updates",
  {
    id: id(),
    orgId: orgRef(),
    goalId: uuid("goal_id").notNull(),
    progressPercent: integer("progress_percent").notNull(),
    note: text("note"),
    actorUserId: uuid("actor_user_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "hrm_goal_updates_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_goal_updates_goal_tenant_fkey",
      columns: [t.orgId, t.goalId],
      foreignColumns: [hrmGoals.orgId, hrmGoals.id],
    }),
    uniqueIndex("hrm_goal_updates_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_goal_updates_goal").on(t.orgId, t.goalId, t.recordedAt),
    check(
      "hrm_goal_updates_progress",
      sql`${t.progressPercent} >= 0 and ${t.progressPercent} <= 100`,
    ),
  ],
);

/** The exit record for a terminated employment: one per employment. */
export const hrmExitRecords = pgTable(
  "hrm_exit_records",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    /** Terminating employment_changes row, when the termination rode a change request. */
    terminationChangeId: uuid("termination_change_id"),
    reasonKind: text("reason_kind").notNull(),
    isVoluntary: boolean("is_voluntary").notNull(),
    isRegrettable: boolean("is_regrettable"),
    wouldRehire: boolean("would_rehire"),
    interviewHeldOn: date("interview_held_on"),
    interviewerPartyId: uuid("interviewer_party_id"),
    destination: text("destination"),
    notes: text("notes"),
    recordedBy: uuid("recorded_by"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_exit_records_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_exit_records_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "hrm_exit_records_change_tenant_fkey",
      columns: [t.orgId, t.terminationChangeId],
      foreignColumns: [employmentChanges.orgId, employmentChanges.id],
    }),
    foreignKey({
      name: "hrm_exit_records_interviewer_tenant_fkey",
      columns: [t.orgId, t.interviewerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_exit_records_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_exit_records_org_employment_unique").on(t.orgId, t.employmentId),
    index("hrm_exit_records_reason").on(t.orgId, t.reasonKind),
    check(
      "hrm_exit_records_reason",
      sql`${t.reasonKind} in ('resignation', 'retirement', 'end_of_contract', 'dismissal', 'redundancy', 'mutual', 'death', 'other')`,
    ),
    check(
      "hrm_exit_records_interview_paired",
      sql`(${t.interviewHeldOn} is null) = (${t.interviewerPartyId} is null)`,
    ),
  ],
);
