import { accounts } from "./coa";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
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
import { auditColumns, currencyCode, id, orgRef } from "./helpers";

/**
 * Multi-book accounting configuration and evidence (migration 0682). The
 * replication settings themselves live on accounting_books
 * (replication_mode, replication_from, currency_difference_account_id).
 */

export const BOOK_REPLICATION_MODES = ["adjustment_only", "full"] as const;
export type BookReplicationMode = (typeof BOOK_REPLICATION_MODES)[number];

/** The physical posting book and its retained replication basis. */
export const accountingBooks = pgTable(
  "accounting_books",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    postsGl: boolean("posts_gl").notNull().default(true),
    replicationMode: text("replication_mode", { enum: BOOK_REPLICATION_MODES })
      .notNull()
      .default("adjustment_only"),
    replicationFrom: date("replication_from"),
    currencyDifferenceAccountId: uuid("currency_difference_account_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("accounting_books_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("books_org_code").on(t.orgId, t.code),
    foreignKey({
      columns: [t.orgId, t.currencyDifferenceAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

export const BOOK_OPENING_STRATEGIES = ["full_history", "opening_balances"] as const;
export type BookOpeningStrategy = (typeof BOOK_OPENING_STRATEGIES)[number];
export const BOOK_REPLICATION_RUN_KINDS = [
  "activation",
  "catch_up",
  "deactivation",
  "settings",
] as const;
export type BookReplicationRunKind = (typeof BOOK_REPLICATION_RUN_KINDS)[number];
export const BOOK_CURRENCY_RATE_TYPES = ["spot", "month_average"] as const;

/** Effective-dated base currency and rate type of a secondary book for one subsidiary. */
export const accountingBookCurrencies = pgTable(
  "accounting_book_currencies",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    currency: currencyCode("currency").notNull(),
    rateType: text("rate_type", { enum: BOOK_CURRENCY_RATE_TYPES }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("accounting_book_currencies_org_id_id_key").on(t.orgId, t.id),
    check(
      "accounting_book_currencies_window_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Effective-dated mapping of a chart account to the account a secondary book carries it in. */
export const accountingBookAccountMaps = pgTable(
  "accounting_book_account_maps",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    sourceAccountId: uuid("source_account_id").notNull(),
    targetAccountId: uuid("target_account_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("accounting_book_account_maps_org_id_id_key").on(t.orgId, t.id),
    index("accounting_book_account_maps_lookup").on(
      t.orgId,
      t.bookId,
      t.sourceAccountId,
      t.effectiveFrom,
    ),
    check(
      "accounting_book_account_maps_distinct",
      sql`${t.sourceAccountId} <> ${t.targetAccountId}`,
    ),
  ],
);

/** Append-only record of each replication activation, catch-up, deactivation and settings change. */
export const accountingBookReplicationRuns = pgTable(
  "accounting_book_replication_runs",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    kind: text("kind", { enum: BOOK_REPLICATION_RUN_KINDS }).notNull(),
    modeBefore: text("mode_before", { enum: BOOK_REPLICATION_MODES }).notNull(),
    modeAfter: text("mode_after", { enum: BOOK_REPLICATION_MODES }).notNull(),
    replicationFrom: date("replication_from"),
    openingStrategy: text("opening_strategy", { enum: BOOK_OPENING_STRATEGIES }),
    openingEntryIds: uuid("opening_entry_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    replicatedCount: integer("replicated_count").notNull().default(0),
    excludedCount: integer("excluded_count").notNull().default(0),
    settings: jsonb("settings").notNull().default({}),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    createdTxid: bigint("created_txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
  },
  (t) => [
    uniqueIndex("accounting_book_replication_runs_org_id_id_key").on(t.orgId, t.id),
    index("accounting_book_replication_runs_book").on(t.orgId, t.bookId, t.createdAt),
  ],
);

/** One row per full book and replicated primary entry (append-only). */
export const bookEntryReplications = pgTable(
  "book_entry_replications",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    sourceEntryId: uuid("source_entry_id").notNull(),
    replicaEntryId: uuid("replica_entry_id"),
    outcome: text("outcome", { enum: ["replicated", "excluded"] }).notNull(),
    detail: jsonb("detail").notNull().default({}),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("book_entry_replications_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("book_entry_replications_once").on(t.orgId, t.bookId, t.sourceEntryId),
    index("book_entry_replications_source").on(t.orgId, t.sourceEntryId),
    check(
      "book_entry_replications_outcome_replica",
      sql`(${t.outcome} = 'replicated') = (${t.replicaEntryId} IS NOT NULL)`,
    ),
  ],
);
