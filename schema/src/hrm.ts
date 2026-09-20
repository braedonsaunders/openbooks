import { sql } from "drizzle-orm";
import {
  bigint,
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
import { auditColumns, id, orgRef } from "./helpers";
import { positions } from "./hrm-positions";
import { parties } from "./parties";
import { subsidiaries } from "./subsidiaries";

/**
 * HRM employment foundation (migration 0184).
 *
 * Additive only; payroll is untouched until the compatibility audit.
 * Native parties carry the worker; subsidiaries carry the legal employer.
 *
 * Stable identity is separated from append-preserved versions:
 * - worker_employments / employment_assignments are stable identity rows
 *   (worker, employer, aggregate revision, assignment slot). They carry no
 *   status, no dates, no is_active. Employer identity is immutable in
 *   storage (worker_employments_identity_guard); a worker_party_id remap
 *   happens ONLY through the audited native party-merge path
 *   (engine/src/sync/party-merges.ts), which the same guard verifies
 *   against the absorbed party's merged_into marker.
 * - worker_employment_versions / employment_assignment_versions /
 *   reporting_relationships carry effective AND recorded intervals. Both
 *   are half-open [from, until): effective_from and recorded_at are NOT
 *   NULL (we always know when a fact was recorded, even when the
 *   historical start is unknown), a null end means unbounded. Unknown
 *   historical hire dates live in the nullable service_start + provenance
 *   pair on the identity row — never as a fake effective start, and never
 *   mapped to -infinity. A backfill asserts CURRENT observed state starting
 *   at the observation date only.
 * - Every closure sets recorded_until + superseded_by atomically and appends
 *   an employment_changes evidence row, so a narrowed correction never
 *   resurrects prior facts in the removed period. The service writes
 *   close/insert/evidence in ONE transaction in any order (one aggregate
 *   change may close SEVERAL versions under a single event); the deferred
 *   hrm_closure_evidence_guard proves at commit an adjacent strictly-newer
 *   successor plus a same-transaction event (change_txid stamped immutable
 *   at insert) linked by closed_by_change_id and naming the exact closure
 *   in closed_versions. Closed rows are immutable (closure guards allowlist
 *   the closing transition only; deletes admitted only on the governed
 *   amend path used by fixture teardown).
 * - CANONICAL EMPLOYER, NO LEGACY PROJECTION: employer_subsidiary_id is
 *   the single employer of record. No backfill or activation here: source
 *   rows with ambiguous employer or start date are refused by the one-time
 *   data-preserving migration (parent integration), never fabricated; a
 *   legacy null subsidiary means UNKNOWN, never the org root.
 * - employment_changes rows are immutable evidence (storage rejects UPDATE
 *   and DELETE). Reason is non-blank; the actor is a users row or a named
 *   system source reference.
 * - offered status is a future engagement and may precede the employee
 *   role; nothing here requires employee_roles.
 * - is_primary is an effective-dated assignment fact on the version row.
 *   Storage guarantees AT MOST one live primary per employment at any
 *   effective time (exclusion constraint); primary reassignment over time
 *   is separate non-overlapping primary versions.
 *
 * Overlap exclusion and cycle guards that need storage-level concurrency
 * safety live in the SQL migration (Drizzle has no exclusion primitive).
 */

/** Stable employment identity: one worker employed by one legal employer. */
export const workerEmployments = pgTable(
  "worker_employments",
  {
    id: id(),
    orgId: orgRef(),
    workerPartyId: uuid("worker_party_id").notNull(),
    employerSubsidiaryId: uuid("employer_subsidiary_id").notNull(),
    employmentNumber: text("employment_number"),
    /**
     * Aggregate optimistic-concurrency revision: bumped by exactly one on
     * ANY change under this employment (status, assignment, reporting).
     * Per-chain version_no is not enough across chains; writers match this
     * revision and increment it in one UPDATE.
     */
    revision: integer("revision").notNull().default(1),
    /**
     * Original hire/service start, when actually known. Null = unknown:
     * backfill asserts current observed state from the observation date
     * only and never claims this date. Provenance names the source
     * (e.g. 'prior-provider export', 'backfill-0184 observed <date>').
     */
    serviceStart: date("service_start"),
    serviceStartProvenance: text("service_start_provenance"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "worker_employments_worker_tenant_fkey",
      columns: [t.orgId, t.workerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "worker_employments_employer_tenant_fkey",
      columns: [t.orgId, t.employerSubsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    uniqueIndex("worker_employments_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("worker_employments_org_employer_number")
      .on(t.orgId, t.employerSubsidiaryId, t.employmentNumber)
      .where(sql`${t.employmentNumber} is not null`),
    index("worker_employments_worker").on(t.orgId, t.workerPartyId),
    index("worker_employments_employer").on(t.orgId, t.employerSubsidiaryId),
    check("worker_employments_revision", sql`${t.revision} >= 1`),
    check(
      "worker_employments_service_start",
      sql`(${t.serviceStart} is null and ${t.serviceStartProvenance} is null)
          or (${t.serviceStart} is not null and ${t.serviceStartProvenance} is not null
              and char_length(btrim(${t.serviceStartProvenance})) > 0)`,
    ),
    // Finite civil time (storage contract 0184): PostgreSQL dates also admit
    // infinity/BC/year > 9999, which the reader refuses — so they must not be
    // savable. NULL alone means unbounded; every non-null bound is pinned.
    check(
      "worker_employments_finite_time",
      sql`${t.serviceStart} is null
          or ${t.serviceStart} between date '0001-01-01' and date '9999-12-31'`,
    ),
  ],
);

/**
 * Status versions of one employment. Rehire = a new worker_employments row;
 * concurrent employments = several identity rows per worker. Both are
 * explicitly allowed, so there is no exclusion constraint at this level.
 */
export const workerEmploymentVersions = pgTable(
  "worker_employment_versions",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    versionNo: integer("version_no").notNull(),
    status: text("status", {
      enum: ["offered", "active", "on_leave", "suspended", "terminated"],
    }).notNull(),
    /** Half-open effective start; always known (backfill uses observation date). */
    effectiveFrom: date("effective_from").notNull(),
    /** Half-open effective end (exclusive); null = unbounded. */
    effectiveTo: date("effective_to"),
    /** Recorded-window start (exclusive end below); always known. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    /** Recorded-window end (exclusive); null = currently asserted. */
    recordedUntil: timestamp("recorded_until", { withTimezone: true }),
    /** Version that closed this one; null = live. Names a real version_no. */
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
    foreignKey({
      name: "worker_employment_versions_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    uniqueIndex("worker_employment_versions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("worker_employment_versions_employment_no").on(t.orgId, t.employmentId, t.versionNo),
    index("worker_employment_versions_employment").on(t.orgId, t.employmentId, t.effectiveFrom),
    // Versions of one employment may not overlap in effective AND recorded
    // time at once (one bitemporal exclusion in the SQL migration, over ALL
    // versions: disjoint effective slices may share recorded windows, and
    // historical overlap is rejected too).
    check("worker_employment_versions_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`),
    check("worker_employment_versions_recorded", sql`${t.recordedUntil} is null or ${t.recordedUntil} > ${t.recordedAt}`),
    check("worker_employment_versions_no", sql`${t.versionNo} >= 1`),
    check(
      "worker_employment_versions_closure",
      sql`(${t.supersededBy} is null) = (${t.recordedUntil} is null)
          and (${t.supersededBy} is null) = (${t.closedByChangeId} is null)`,
    ),
    // Finite civil time: effective_from/recorded_at always known, so always
    // pinned; null ends stay unbounded. Mirrors
    // worker_employment_versions_finite_time (0184).
    check(
      "worker_employment_versions_finite_time",
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

/**
 * Stable assignment identity: one slot within an employment.
 * Concurrent assignments — including job-sharing starts on the same date —
 * are separate rows, so no unique key touches start dates.
 */
export const employmentAssignments = pgTable(
  "employment_assignments",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    assignmentKey: text("assignment_key").notNull(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "employment_assignments_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    uniqueIndex("employment_assignments_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("employment_assignments_employment_key").on(t.orgId, t.employmentId, t.assignmentKey),
    index("employment_assignments_employment").on(t.orgId, t.employmentId),
  ],
);

/**
 * Effective/recorded versions of one assignment slot: title, placement,
 * FTE, and whether it is the primary assignment at that effective time.
 * employment_id is denormalized (provenance trigger
 * employment_assignment_versions_employment_guard) so the at-most-one-live-
 * primary exclusion can key on employment + effective window.
 */
export const employmentAssignmentVersions = pgTable(
  "employment_assignment_versions",
  {
    id: id(),
    orgId: orgRef(),
    assignmentId: uuid("assignment_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    /**
     * Funded establishment slot this version holds (0192). Null = no
     * position. Title, department and location stay on this row and are
     * never inherited from the position version.
     */
    positionId: uuid("position_id"),
    versionNo: integer("version_no").notNull(),
    jobTitle: text("job_title"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    /** Full-time equivalent, e.g. 1.0000; capacity totals are service-side. */
    fte: numeric("fte", { precision: 7, scale: 4 }).notNull().default("1"),
    /** Effective-dated: true only while this slot is the primary one. */
    isPrimary: boolean("is_primary").notNull().default(false),
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
    foreignKey({
      name: "employment_assignment_versions_assignment_tenant_fkey",
      columns: [t.orgId, t.assignmentId],
      foreignColumns: [employmentAssignments.orgId, employmentAssignments.id],
    }),
    foreignKey({
      name: "employment_assignment_versions_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "employment_assignment_versions_department_tenant_fkey",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
    }),
    foreignKey({
      name: "employment_assignment_versions_location_tenant_fkey",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    foreignKey({
      name: "employment_assignment_versions_position_tenant_fkey",
      columns: [t.orgId, t.positionId],
      foreignColumns: [positions.orgId, positions.id],
    }),
    uniqueIndex("employment_assignment_versions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("employment_assignment_versions_assignment_no").on(t.orgId, t.assignmentId, t.versionNo),
    index("employment_assignment_versions_assignment").on(t.orgId, t.assignmentId, t.effectiveFrom),
    index("employment_assignment_versions_employment").on(t.orgId, t.employmentId, t.effectiveFrom),
    index("employment_assignment_versions_position").on(t.orgId, t.positionId),
    // Versions of one slot may not overlap in effective AND recorded time
    // at once, and at most one primary version per employment may cover any
    // (effective, recorded) point; both enforced by bitemporal exclusion
    // constraints in the SQL migration, over ALL versions.
    check("employment_assignment_versions_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`),
    check("employment_assignment_versions_recorded", sql`${t.recordedUntil} is null or ${t.recordedUntil} > ${t.recordedAt}`),
    check("employment_assignment_versions_no", sql`${t.versionNo} >= 1`),
    check(
      "employment_assignment_versions_closure",
      sql`(${t.supersededBy} is null) = (${t.recordedUntil} is null)
          and (${t.supersededBy} is null) = (${t.closedByChangeId} is null)`,
    ),
    check("employment_assignment_versions_fte", sql`${t.fte} > 0 and ${t.fte} != 'NaN'`),
    // Finite civil time, same shape as the employment versions. Mirrors
    // employment_assignment_versions_finite_time (0184).
    check(
      "employment_assignment_versions_finite_time",
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
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "employment_changes_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "employment_changes_assignment_tenant_fkey",
      columns: [t.orgId, t.assignmentId],
      foreignColumns: [employmentAssignments.orgId, employmentAssignments.id],
    }),
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
    foreignKey({
      name: "reporting_relationships_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "reporting_relationships_manager_tenant_fkey",
      columns: [t.orgId, t.managerEmploymentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
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

/**
 * Per-org reporting-graph revision counter: bumped by hrm_reporting_no_cycle
 * on every reporting write before the cycle walk. Storage-only
 * serialization mechanism, never product data.
 */
export const hrmGraphRevisions = pgTable(
  "hrm_graph_revisions",
  {
    orgId: orgRef(),
    rev: bigint("rev", { mode: "number" }).notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_graph_revisions_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
  ],
);
