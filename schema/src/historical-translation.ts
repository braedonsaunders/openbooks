import { sql } from "drizzle-orm";
import {
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
import { currencyCode, fxRate, id, money, orgRef } from "./helpers";
import { journalEntries, journalLines } from "./ledger";
import { accountingBooks } from "./multibook";
import { accounts } from "./coa";
import { subsidiaries } from "./subsidiaries";
import { files, fileVersions } from "./file-cabinet";
import { users } from "./extension";

/** Immutable applied approval evidence, one basis per physical source and presentation currency. */
export const historicalTranslationContributions = pgTable(
  "historical_translation_contributions",
  {
    id: id(),
    orgId: orgRef(),
    changeId: uuid("change_id").notNull(),
    sourceLineId: uuid("source_line_id").notNull(),
    sourceEntryId: uuid("source_entry_id").notNull(),
    bookId: uuid("book_id").notNull(),
    accountId: uuid("account_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    measurementCurrency: currencyCode("measurement_currency").notNull(),
    presentationCurrency: currencyCode("presentation_currency").notNull(),
    sourceAmount: money("source_amount").notNull(),
    postingDate: date("posting_date").notNull(),
    kind: text("kind", { enum: ["contribution", "opening", "correction"] }).notNull(),
    evidence: jsonb("evidence").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("historical_translation_contributions_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("historical_translation_contributions_org_id_change_id_key").on(
      t.orgId,
      t.changeId,
    ),
    uniqueIndex("historical_translation_contributions_source_identity").on(
      t.orgId,
      t.sourceLineId,
      t.presentationCurrency,
    ),
    check("historical_translation_contributions_source_nonzero", sql`${t.sourceAmount}<>0`),
    foreignKey({
      columns: [t.orgId, t.sourceLineId],
      foreignColumns: [journalLines.orgId, journalLines.id],
    }),
    foreignKey({
      columns: [t.orgId, t.sourceEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      columns: [t.orgId, t.bookId],
      foreignColumns: [accountingBooks.orgId, accountingBooks.id],
    }),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({ columns: [t.createdBy], foreignColumns: [users.id] }),
  ],
);

/** Signed contributions and explicit immediate-parent corrections retain their Cabinet evidence. */
export const historicalTranslationLayers = pgTable(
  "historical_translation_layers",
  {
    id: id(),
    orgId: orgRef(),
    basisId: uuid("basis_id").notNull(),
    layerNumber: integer("layer_number").notNull(),
    amount: money("amount").notNull(),
    translatedAmount: numeric("translated_amount", { precision: 38, scale: 14 }).notNull(),
    rate: fxRate("rate").notNull(),
    historicalDate: date("historical_date").notNull(),
    provenance: text("provenance").notNull(),
    sourceFileId: uuid("source_file_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceVersionNumber: integer("source_version_number").notNull(),
    originalLayerId: uuid("original_layer_id"),
  },
  (t) => [
    uniqueIndex("historical_translation_layers_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("historical_translation_layers_basis_number").on(t.orgId, t.basisId, t.layerNumber),
    uniqueIndex("historical_translation_layers_basis_original").on(
      t.orgId,
      t.basisId,
      t.originalLayerId,
    ),
    index("historical_translation_layers_original")
      .on(t.orgId, t.originalLayerId)
      .where(sql`${t.originalLayerId} IS NOT NULL`),
    check("historical_translation_layers_amount_nonzero", sql`${t.amount}<>0`),
    check("historical_translation_layers_rate_positive", sql`${t.rate}>0`),
    foreignKey({
      columns: [t.orgId, t.basisId],
      foreignColumns: [
        historicalTranslationContributions.orgId,
        historicalTranslationContributions.id,
      ],
    }),
    foreignKey({ columns: [t.orgId, t.sourceFileId], foreignColumns: [files.orgId, files.id] }),
    foreignKey({
      columns: [t.sourceFileId, t.sourceVersionId],
      foreignColumns: [fileVersions.fileId, fileVersions.id],
    }),
    foreignKey({ columns: [t.orgId, t.originalLayerId], foreignColumns: [t.orgId, t.id] }),
  ],
);
