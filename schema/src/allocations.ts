import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { accountingPeriods } from "./core";
import { subsidiaries } from "./subsidiaries";
import { documents } from "./documents";
import { timeEntries } from "./time";
import { journalEntries, journalLines } from "./ledger";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Allocation kernel — ONE rule model bound at three moments (see
 * docs/design/allocation-kernel.md):
 *
 *   entry  — a saved document line explodes into a group of child lines
 *   post   — extra journal lines contributed to the transaction's own entry
 *   period — a scheduled/manual sweep of pooled balances to targets
 *
 * Rules are versioned and effective-dated; a published version is frozen
 * (its `definition_hash` is stamped on every run and lineage row), so a
 * posted allocation can always be explained by the exact definition that
 * produced it. Drivers are a registry of measures (statistical journals, GL
 * activity/balance, native measures, manual tables, report definitions).
 * Every allocated line traces back through `allocation_lineage`.
 */

export const ALLOCATION_MODES = ["entry", "post", "period"] as const;
export const ALLOCATION_RUN_STATUSES = [
  "previewed",
  "pending_approval",
  "posted",
  "reversed",
  "failed",
  "superseded",
] as const;
export const ALLOCATION_RUN_TRIGGERS = ["manual", "scheduled", "close_automation", "rerun"] as const;

/** One computed/posted period-mode run. */
export const allocationRuns = pgTable(
  "allocation_runs",
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid("rule_id").notNull(),
    versionId: uuid("version_id").notNull(),
    definitionHash: text("definition_hash").notNull(),
    periodId: uuid("period_id").notNull(),
    bookId: uuid("book_id").notNull(),
    /** null = every subsidiary in scope. */
    subsidiaryId: uuid("subsidiary_id"),
    status: text("status", { enum: ALLOCATION_RUN_STATUSES }).notNull(),
    triggerKind: text("trigger_kind", { enum: ALLOCATION_RUN_TRIGGERS }).notNull().default("manual"),
    sourceTotal: money("source_total").notNull().default("0"),
    allocatedTotal: money("allocated_total").notNull().default("0"),
    residual: money("residual").notNull().default("0"),
    journalEntryId: uuid("journal_entry_id"),
    reversalEntryId: uuid("reversal_entry_id"),
    reversesRunId: uuid("reverses_run_id"),
    supersededByRunId: uuid("superseded_by_run_id"),
    /** Full explain payload: sources, driver vector, per-target weight/share/amount/residual. */
    computation: jsonb("computation").notNull().default({}),
    /** sha256 of the canonical computation — equal fingerprints mean "nothing changed". */
    fingerprint: text("fingerprint"),
    error: text("error"),
    flowRunId: uuid("flow_run_id"),
    requestedBy: uuid("requested_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("allocation_runs_org_id_id_unique").on(t.orgId, t.id),
    index("allocation_runs_rule_period").on(t.orgId, t.ruleId, t.periodId, t.bookId),
    index("allocation_runs_status").on(t.orgId, t.status, t.createdAt),
    uniqueIndex("allocation_runs_one_posted")
      .on(t.orgId, t.ruleId, t.periodId, t.bookId, sql`coalesce(${t.subsidiaryId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.status} = 'posted'`),


    foreignKey({
      name: "allocation_runs_period_id_fkey",
      columns: [t.orgId, t.periodId],
      foreignColumns: [accountingPeriods.orgId, accountingPeriods.id],
    }),

    foreignKey({
      name: "allocation_runs_subsidiary_id_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "allocation_runs_journal_entry_id_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "allocation_runs_reversal_entry_id_fkey",
      columns: [t.orgId, t.reversalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);

/** Every allocated line traces to its source line, rule version, and driver. */
export const allocationLineage = pgTable(
  "allocation_lineage",
  {
    id: id(),
    orgId: orgRef(),
    mode: text("mode", { enum: ALLOCATION_MODES }).notNull(),
    ruleId: uuid("rule_id").notNull(),
    versionId: uuid("version_id").notNull(),
    definitionHash: text("definition_hash").notNull(),
    runId: uuid("run_id"),
    documentId: uuid("document_id"),
    journalEntryId: uuid("journal_entry_id"),
    journalLineId: uuid("journal_line_id"),
    sourceJournalLineId: uuid("source_journal_line_id"),
    sourceDocumentLineId: uuid("source_document_line_id"),
    targetDocumentLineId: uuid("target_document_line_id"),
    /** Event trigger for event-bound post rules (the overhead net-zero pair): the approved time entry. */
    sourceTimeEntryId: uuid("source_time_entry_id"),
    driverId: uuid("driver_id"),
    driverValue: numeric("driver_value", { precision: 19, scale: 4 }),
    driverTotal: numeric("driver_total", { precision: 19, scale: 4 }),
    share: numeric("share", { precision: 19, scale: 10 }),
    amount: money("amount").notNull().default("0"),
    residual: money("residual").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("allocation_lineage_entry").on(t.orgId, t.journalEntryId),
    index("allocation_lineage_run").on(t.orgId, t.runId),
    index("allocation_lineage_rule").on(t.orgId, t.ruleId, t.createdAt),
    index("allocation_lineage_document").on(t.orgId, t.documentId),
    index("allocation_lineage_time_entry")
      .on(t.orgId, t.sourceTimeEntryId)
      .where(sql`${t.sourceTimeEntryId} is not null`),


    foreignKey({
      name: "allocation_lineage_run_id_fkey",
      columns: [t.orgId, t.runId],
      foreignColumns: [allocationRuns.orgId, allocationRuns.id],
    }),
    foreignKey({
      name: "allocation_lineage_document_id_fkey",
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    foreignKey({
      name: "allocation_lineage_journal_entry_id_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "allocation_lineage_journal_line_id_fkey",
      columns: [t.orgId, t.journalLineId],
      foreignColumns: [journalLines.orgId, journalLines.id],
    }),
    foreignKey({
      name: "allocation_lineage_source_journal_line_id_fkey",
      columns: [t.orgId, t.sourceJournalLineId],
      foreignColumns: [journalLines.orgId, journalLines.id],
    }),

    foreignKey({
      name: "allocation_lineage_time_entry_id_fkey",
      columns: [t.orgId, t.sourceTimeEntryId],
      foreignColumns: [timeEntries.orgId, timeEntries.id],
      // Evidence follows its anchor, like the run/document lineage anchors.
    }).onDelete("cascade"),
    check(
      "allocation_lineage_anchor",
      sql`${t.runId} is not null or ${t.documentId} is not null or ${t.sourceTimeEntryId} is not null`,
    ),
  ],
);
