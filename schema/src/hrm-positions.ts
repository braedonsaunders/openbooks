import { sql } from "drizzle-orm";
import {
  bigint,
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
import { accountingPeriods, departments, locations, orgs } from "./core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";
import { subsidiaries } from "./subsidiaries";

/**
 * HRM positions and the headcount plan (migration 0192).
 *
 * The funded establishment (positions) is separated from the people who hold
 * it (0184 employments/assignments): positions carry title, placement,
 * planned FTE and lifecycle status as bitemporal versions in the exact 0184
 * shape; position_funding carries one plan row per (position, fiscal period);
 * position_changes is the immutable evidence ledger in the
 * employment_changes style. employment_assignment_versions.position_id links
 * a held slot to its establishment without inheriting anything.
 *
 * Overlap exclusion and closure/evidence guards that need storage-level
 * concurrency safety live in the SQL migration (Drizzle has no exclusion
 * primitive).
 */

/** Stable position identity: one funded establishment slot per org code. */
export const positions = pgTable(
  "positions",
  {
    id: id(),
    orgId: orgRef(),
    positionCode: text("position_code").notNull(),
    /**
     * Aggregate optimistic-concurrency revision: bumped by exactly one on
     * ANY change under this position (revise, funding write, close).
     */
    revision: integer("revision").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "positions_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    uniqueIndex("positions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("positions_org_code_unique").on(t.orgId, t.positionCode),
    index("positions_org").on(t.orgId),
    check("positions_revision", sql`${t.revision} >= 1`),
    check("positions_code_not_blank", sql`char_length(btrim(${t.positionCode})) > 0`),
  ],
);

/**
 * Versions of one position: title, placement, employer, grade, planned FTE
 * and lifecycle status with half-open effective AND recorded intervals.
 */
export const positionVersions = pgTable(
  "position_versions",
  {
    id: id(),
    orgId: orgRef(),
    positionId: uuid("position_id").notNull(),
    versionNo: integer("version_no").notNull(),
    title: text("title").notNull(),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    /** Legal employer owning this headcount slot; never null. */
    employerSubsidiaryId: uuid("employer_subsidiary_id").notNull(),
    /** Job family or grade, free text for now (no grade table). */
    jobGrade: text("job_grade"),
    /** Establishment size, e.g. 1.0000; capacity totals are service-side. */
    plannedFte: numeric("planned_fte", { precision: 7, scale: 4 }).notNull(),
    status: text("status", {
      enum: ["planned", "open", "filled", "frozen", "closed"],
    }).notNull(),
    /** Half-open effective start; always known. */
    effectiveFrom: date("effective_from").notNull(),
    /** Half-open effective end (exclusive); null = unbounded. */
    effectiveTo: date("effective_to"),
    /** Recorded-window start; always known. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    /** Recorded-window end (exclusive); null = currently asserted. */
    recordedUntil: timestamp("recorded_until", { withTimezone: true }),
    /** Version that closed this one; null = live. Names a real version_no. */
    supersededBy: integer("superseded_by"),
    /**
     * Link to the ONE aggregate evidence event for this closure (null =
     * live). Composite FK to position_changes(org_id, id) in the migration.
     */
    closedByChangeId: uuid("closed_by_change_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "position_versions_position_tenant_fkey",
      columns: [t.orgId, t.positionId],
      foreignColumns: [positions.orgId, positions.id],
    }),
    foreignKey({
      name: "position_versions_department_tenant_fkey",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
    }),
    foreignKey({
      name: "position_versions_location_tenant_fkey",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    foreignKey({
      name: "position_versions_employer_tenant_fkey",
      columns: [t.orgId, t.employerSubsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    uniqueIndex("position_versions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("position_versions_position_no").on(t.orgId, t.positionId, t.versionNo),
    index("position_versions_position").on(t.orgId, t.positionId, t.effectiveFrom),
    check("position_versions_title_not_blank", sql`char_length(btrim(${t.title})) > 0`),
    check("position_versions_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`),
    check("position_versions_recorded", sql`${t.recordedUntil} is null or ${t.recordedUntil} > ${t.recordedAt}`),
    check("position_versions_no", sql`${t.versionNo} >= 1`),
    check(
      "position_versions_closure",
      sql`(${t.supersededBy} is null) = (${t.recordedUntil} is null)
          and (${t.supersededBy} is null) = (${t.closedByChangeId} is null)`,
    ),
    check(
      "position_versions_finite_time",
      sql`${t.effectiveFrom} between date '0001-01-01' and date '9999-12-31'
          and (${t.effectiveTo} is null
               or ${t.effectiveTo} between date '0001-01-01' and date '9999-12-31')
          and ${t.recordedAt} >= timestamptz '0001-01-01 00:00:00+00'
          and ${t.recordedAt} < timestamptz '10000-01-01 00:00:00+00'
          and (${t.recordedUntil} is null
               or (${t.recordedUntil} >= timestamptz '0001-01-01 00:00:00+00'
                   and ${t.recordedUntil} < timestamptz '10000-01-01 00:00:00+00'))`,
    ),
    check("position_versions_planned_fte", sql`${t.plannedFte} > 0 and ${t.plannedFte} != 'NaN'`),
  ],
);

/**
 * Headcount-plan funding: one plan row per (position, fiscal period) with
 * funded FTE and an optional cost-plan amount. Periods are referenced the
 * way budgets reference them (a plain FK to accounting_periods, same-org
 * proven by the service). Storage pins funded_fte >= 0 only: the
 * plan-vs-funded comparison is a service preflight, never a row rejection.
 */
export const positionFunding = pgTable(
  "position_funding",
  {
    id: id(),
    orgId: orgRef(),
    positionId: uuid("position_id").notNull(),
    periodId: uuid("period_id").notNull(),
    fundedFte: numeric("funded_fte", { precision: 7, scale: 4 }).notNull(),
    /** Opaque planning-dimension reference; null = unfunded by a source. */
    fundingSourceId: uuid("funding_source_id"),
    /** Optional cost plan; paired with currency (both or neither). */
    amount: money("amount"),
    currency: currencyCode("currency"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "position_funding_position_tenant_fkey",
      columns: [t.orgId, t.positionId],
      foreignColumns: [positions.orgId, positions.id],
    }),
    foreignKey({
      name: "position_funding_period_fkey",
      columns: [t.periodId],
      foreignColumns: [accountingPeriods.id],
    }),
    uniqueIndex("position_funding_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("position_funding_position_period").on(t.orgId, t.positionId, t.periodId),
    index("position_funding_position").on(t.orgId, t.positionId),
    index("position_funding_period").on(t.orgId, t.periodId),
    check("position_funding_funded_fte", sql`${t.fundedFte} >= 0 and ${t.fundedFte} != 'NaN'`),
    check(
      "position_funding_amount_currency",
      sql`(${t.amount} is null and ${t.currency} is null)
          or (${t.amount} is not null and ${t.currency} is not null
              and ${t.amount} != 'NaN' and ${t.currency} ~ '^[A-Z]{3}$')`,
    ),
  ],
);

/**
 * Immutable position revision evidence in the employment_changes style:
 * every position write appends one row with prior image, non-blank reason,
 * and a users row or named system source. Closure proof is deferred
 * (position_closure_evidence_guard + reverse guard in the migration).
 */
export const positionChanges = pgTable(
  "position_changes",
  {
    id: id(),
    orgId: orgRef(),
    positionId: uuid("position_id").notNull(),
    /** Monotonic per position; orders evidence. */
    revision: integer("revision").notNull(),
    changeKind: text("change_kind", {
      enum: ["created", "revised", "funded", "assigned", "unassigned", "closed"],
    }).notNull(),
    /** Prior image of the position state before the change. */
    priorSnapshot: jsonb("prior_snapshot").notNull(),
    reason: text("reason").notNull(),
    /** 'user' = recorded_by names the users row; 'system' = named process. */
    recordedSource: text("recorded_source", { enum: ["user", "system"] })
      .notNull()
      .default("user"),
    recordedBy: uuid("recorded_by"),
    /** The autonomous process or job, e.g. 'position-funding <run id>'. */
    recordedSourceRef: text("recorded_source_ref"),
    /**
     * Immutable transaction stamp, ALWAYS set by the
     * position_changes_stamp_txid trigger (never supplied by callers).
     */
    changeTxid: bigint("change_txid", { mode: "number" }),
    /**
     * Exact closed-version/before-image array for closures under this ONE
     * aggregate change. Empty array for non-closure events. Proven deferred
     * (position_closure_evidence_guard) against the linked version rows.
     */
    closedVersions: jsonb("closed_versions").$type<unknown[]>().notNull().default([]),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "position_changes_position_tenant_fkey",
      columns: [t.orgId, t.positionId],
      foreignColumns: [positions.orgId, positions.id],
    }),
    uniqueIndex("position_changes_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("position_changes_position_revision").on(t.orgId, t.positionId, t.revision),
    index("position_changes_position").on(t.orgId, t.positionId, t.revision),
    check("position_changes_revision", sql`${t.revision} >= 1`),
    check("position_changes_reason", sql`char_length(btrim(${t.reason})) > 0`),
    check(
      "position_changes_snapshot",
      sql`jsonb_typeof(${t.priorSnapshot}) = 'object'`,
    ),
    check(
      "position_changes_actor",
      sql`(${t.recordedSource} = 'user' and ${t.recordedBy} is not null and ${t.recordedSourceRef} is null)
          or (${t.recordedSource} = 'system' and ${t.recordedBy} is null
              and ${t.recordedSourceRef} is not null
              and char_length(btrim(${t.recordedSourceRef})) > 0)`,
    ),
    check(
      "position_changes_closed_versions",
      sql`jsonb_typeof(${t.closedVersions}) = 'array'`,
    ),
    check(
      "position_changes_finite_time",
      sql`${t.recordedAt} >= timestamptz '0001-01-01 00:00:00+00'
          and ${t.recordedAt} < timestamptz '10000-01-01 00:00:00+00'`,
    ),
  ],
);

export const POSITION_STATUSES = ["planned", "open", "filled", "frozen", "closed"] as const;
export const POSITION_CHANGE_KINDS = [
  "created",
  "revised",
  "funded",
  "assigned",
  "unassigned",
  "closed",
] as const;
