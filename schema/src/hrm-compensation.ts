import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
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
import { files } from "./file-cabinet";
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";

/**
 * HRM compensation (migrations 0221/0222).
 *
 * What a role SHOULD pay (families, levels, versioned bands), how a raise
 * is decided (cycles with snapshotted lines and an append-only event
 * ledger, frozen statements), what the workforce will cost (headcount
 * plans with computed line costs), and whether pay is equitable (frozen
 * gap snapshots, information requests).
 *
 * - hrm_job_families / hrm_job_levels are CONFIGURATION: stable per-org
 *   codes, NULL family = the org-wide ladder. A level never moves
 *   ladders; the ladder-rank and per-ladder code uniques are partial
 *   indexes (Drizzle has no partial-unique primitive) and live in SQL.
 * - hrm_pay_bands are versioned SHOULD-pay rows with a scope-overlap
 *   GiST exclusion in SQL; Drizzle declares the columns and tenant FKs.
 * - hrm_comp_cycles / budgets / lines / events / statements are HISTORY:
 *   lines snapshot the payroll-side wage at open; events are append-only;
 *   statements are frozen rows. Push writes through the canonical
 *   labor_cost_rates writer and links pushed_rate_id (single-column FK to
 *   the rates primary key — the baseline table has no UNIQUE (org_id,
 *   id) for a composite FK; cross-org safety is RLS plus a service
 *   check that the rate row's org matches the cycle's).
 * - SQL-only edges (documented, not declared): scope slot generated
 *   columns, the exclusion constraint, partial uniques, the
 *   immutability triggers, and actor columns → users(id).
 */

export const HRM_COMP_CYCLE_SUBJECT_KIND = "hrm_comp_cycle";

/** One decision per cycle per employment, snapshotted at open. */
export const compCycleLines = pgTable(
  "hrm_comp_cycle_lines",
  {
    id: id(),
    orgId: orgRef(),
    cycleId: uuid("cycle_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    currentRate: numeric("current_rate", { precision: 19, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    basis: text("basis").notNull(),
    bandId: uuid("band_id"),
    compaRatio: numeric("compa_ratio", { precision: 19, scale: 10 }),
    ratingKey: text("rating_key"),
    guidelineMinPct: numeric("guideline_min_pct", { precision: 19, scale: 6 }),
    guidelineMaxPct: numeric("guideline_max_pct", { precision: 19, scale: 6 }),
    proposedPct: numeric("proposed_pct", { precision: 19, scale: 6 }),
    proposedRate: numeric("proposed_rate", { precision: 19, scale: 4 }),
    // Frozen budget evidence (0243): written once at open, read by
    // pacing, never refilled. Null for identity/null-envelope cases
    // and for pre-freeze legacy rows (which pacing refuses by name).
    budgetPricingDate: date("budget_pricing_date"),
    budgetCycleCurrency: text("budget_cycle_currency"),
    budgetEnvelope: numeric("budget_envelope", { precision: 19, scale: 4 }),
    budgetAnnualHours: numeric("budget_annual_hours", { precision: 19, scale: 4 }),
    budgetFxRate: numeric("budget_fx_rate", { precision: 19, scale: 10 }),
    budgetFxAsof: date("budget_fx_asof"),
    budgetFxSource: text("budget_fx_source"),
    budgetFxInverse: boolean("budget_fx_inverse"),
    proposedBy: uuid("proposed_by"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    approverPartyId: uuid("approver_party_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    pushedRateId: uuid("pushed_rate_id"),
    revision: integer("revision").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_comp_cycle_lines_approver_party_tenant_fkey",
      columns: [t.orgId, t.approverPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({ name: "hrm_comp_cycle_lines_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),


    uniqueIndex("hrm_comp_cycle_lines_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_comp_cycle_lines_one_per_employment").on(t.cycleId, t.employmentId),
    check(
      "hrm_comp_cycle_lines_status",
      sql`${t.status} in ('pending', 'proposed', 'approved', 'rejected', 'pushed')`,
    ),
  ],
);

/** Frozen per-employment total-rewards payloads. */
export const compStatements = pgTable(
  "hrm_comp_statements",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    cycleId: uuid("cycle_id"),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    payload: jsonb("payload").notNull(),
    fileId: uuid("file_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedBy: uuid("generated_by"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_comp_statements_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),

    foreignKey({
      name: "hrm_comp_statements_file_tenant_fkey",
      columns: [t.orgId, t.fileId],
      foreignColumns: [files.orgId, files.id],
    }),
  ],
);

/** Worker requests for their category averages. */
export const payInformationRequests = pgTable(
  "hrm_pay_information_requests",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    responseSnapshotId: uuid("response_snapshot_id"),
    status: text("status").notNull().default("open"),
    reason: text("reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_pay_information_requests_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),


    check(
      "hrm_pay_information_requests_status",
      sql`${t.status} in ('open', 'fulfilled', 'refused')`,
    ),
  ],
);

