import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Native Flows subject kind for operator employment mapping sets
 * (migration 0408: hrm_employment_migration_approvals). The Flows adapter
 * owns the approval lifecycle over this kind; the migration preflight and
 * verifier bind operator mapping authority to it. Both sides import this
 * constant — never a second literal — so a rename cannot strand one side
 * on the old kind.
 */
export const HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND =
  "hrm_employment_migration_mapping";

/**
 * Immutable revision evidence: every version closure appends one row with
 * the prior image, a non-blank reason, and an attributable actor. Never
 * updated or deleted (employment_changes_immutable).
 */
export const employmentChanges = pgTable(
  "employment_changes",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    assignmentId: uuid("assignment_id"),
    /** Monotonic per employment; the supersedes chain orders evidence. */
    revision: integer("revision").notNull(),
    supersedesId: uuid("supersedes_id"),
    changeKind: text("change_kind", {
      enum: [
        "created",
        "status_changed",
        "assignment_issued",
        "assignment_superseded",
        "corrected",
        "terminated",
        "rehired_reference",
      ],
    }).notNull(),
    /** Prior image of the employment/assignment state before the change. */
    priorSnapshot: jsonb("prior_snapshot").notNull(),
    reason: text("reason").notNull(),
    /** 'user' = recorded_by names the users row; 'system' = named process. */
    recordedSource: text("recorded_source", { enum: ["user", "system"] })
      .notNull()
      .default("user"),
    /** Required for user actors (FK employment_changes_recorded_by_fkey);
     * null for system actors, which instead name recorded_source_ref. */
    recordedBy: uuid("recorded_by"),
    /** The autonomous process or job, e.g. 'party-merge <run id>'. */
    recordedSourceRef: text("recorded_source_ref"),
    /**
     * Immutable transaction stamp, ALWAYS set by the
     * employment_changes_stamp_txid trigger (never supplied by callers).
     */
    changeTxid: bigint("change_txid", { mode: "number" }),
    /**
     * Exact closed-version/before-image array for closures under this ONE
     * aggregate change (status + several assignment corrections may share
     * one event). Empty array for non-closure events. Proven deferred
     * (hrm_closure_evidence_guard) against the linked version rows.
     */
    closedVersions: jsonb("closed_versions").$type<unknown[]>().notNull().default([]),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    /** Generic HR action carried from the request (0227). */
    action: text("action"),
    /** Reason code carried from the request (0227). */
    reasonCode: text("reason_code"),
    /** Event verb: apply, cancel, rescind, correct (0227). Rescind and
     *  correct are appended EVENTS over prior changes, never edits. */
    verb: text("verb", { enum: ["apply", "cancel", "rescind", "correct"] })
      .notNull()
      .default("apply"),
    /** Rescind names the completed change it reverses (0227). */
    reversesChangeId: uuid("reverses_change_id"),
    /** Correct names the completed change it supersedes (0227). */
    correctedChangeId: uuid("corrected_change_id"),
    ...auditColumns,
  },
  (t) => [


    uniqueIndex("employment_changes_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("employment_changes_employment_revision").on(t.orgId, t.employmentId, t.revision),
    index("employment_changes_employment").on(t.orgId, t.employmentId, t.revision),
    // Same-employment provenance (assignment belongs to this employment;
    // supersedes names earlier evidence for this employment) is enforced by
    // employment_changes_provenance_guard: FKs alone cannot express it.
    check("employment_changes_revision", sql`${t.revision} >= 1`),
    check("employment_changes_reason", sql`char_length(btrim(${t.reason})) > 0`),
    check(
      "employment_changes_snapshot",
      sql`jsonb_typeof(${t.priorSnapshot}) = 'object'`,
    ),
    check(
      "employment_changes_actor",
      sql`(${t.recordedSource} = 'user' and ${t.recordedBy} is not null and ${t.recordedSourceRef} is null)
          or (${t.recordedSource} = 'system' and ${t.recordedBy} is null
              and ${t.recordedSourceRef} is not null
              and char_length(btrim(${t.recordedSourceRef})) > 0)`,
    ),
    check(
      "employment_changes_closed_versions",
      sql`jsonb_typeof(${t.closedVersions}) = 'array'`,
    ),
    // Finite civil time: evidence is always recorded at a known instant.
    // Mirrors employment_changes_finite_time (0184).
    check(
      "employment_changes_finite_time",
      sql`${t.recordedAt} >= timestamptz '0001-01-01 00:00:00+00'
          and ${t.recordedAt} < timestamptz '10000-01-01 00:00:00+00'`,
    ),
  ],
);

/**
 * Dated reporting lines with their own recorded windows and closure.
 * kind='line' is the singular reporting line (at most one line per
 * subordinate at any (effective, recorded) point, enforced in storage over
 * ALL versions); kind='matrix' lines are simultaneous and unconstrained.
 * Closed rows are immutable and excluded from the manager-cycle walk
 * (hrm_reporting_no_cycle).
 */
export const reportingRelationships = pgTable(
  "reporting_relationships",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    managerEmploymentId: uuid("manager_employment_id").notNull(),
    kind: text("kind", { enum: ["line", "matrix"] }).notNull().default("line"),
    /**
     * Stable relationship identity across manager changes: every version of
     * one subordinate's LINE shares one id (a manager change closes the old
     * version and opens the next under the same id); each MATRIX edge owns
     * a fresh id. superseded_by chains within this id.
     */
    relationshipId: uuid("relationship_id").notNull(),
    versionNo: integer("version_no").notNull().default(1),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedUntil: timestamp("recorded_until", { withTimezone: true }),
    supersededBy: integer("superseded_by"),
    /**
     * Link to the ONE aggregate evidence event for this closure (null =
     * live). Several versions closed in one operation share one event;
     * composite FK to employment_changes(org_id, id) in the migration.
     */
    closedByChangeId: uuid("closed_by_change_id"),
    ...auditColumns,
  },
  (t) => [


    uniqueIndex("reporting_relationships_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("reporting_relationships_line_version").on(t.orgId, t.relationshipId, t.versionNo),
    index("reporting_relationships_relationship").on(t.orgId, t.relationshipId),
    index("reporting_relationships_employment").on(t.orgId, t.employmentId, t.effectiveFrom),
    index("reporting_relationships_manager").on(t.orgId, t.managerEmploymentId),
    check(
      "reporting_relationships_no_self",
      sql`${t.managerEmploymentId} <> ${t.employmentId}`,
    ),
    check("reporting_relationships_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`),
    check("reporting_relationships_recorded", sql`${t.recordedUntil} is null or ${t.recordedUntil} > ${t.recordedAt}`),
    check("reporting_relationships_no", sql`${t.versionNo} >= 1`),
    check(
      "reporting_relationships_closure",
      sql`(${t.supersededBy} is null) = (${t.recordedUntil} is null)
          and (${t.supersededBy} is null) = (${t.closedByChangeId} is null)`,
    ),
    // Finite civil time, same shape as the version tables. Mirrors
    // reporting_relationships_finite_time (0184).
    check(
      "reporting_relationships_finite_time",
      sql`${t.effectiveFrom} between date '0001-01-01' and date '9999-12-31'
          and (${t.effectiveTo} is null
               or ${t.effectiveTo} between date '0001-01-01' and date '9999-12-31')
          and ${t.recordedAt} >= timestamptz '0001-01-01 00:00:00+00'
          and ${t.recordedAt} < timestamptz '10000-01-01 00:00:00+00'
          and (${t.recordedUntil} is null
               or (${t.recordedUntil} >= timestamptz '0001-01-01 00:00:00+00'
                   and ${t.recordedUntil} < timestamptz '10000-01-01 00:00:00+00'))`,
    ),
  ],
);
