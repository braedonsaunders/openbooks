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
import { id, money, orgRef } from "./helpers";
import { documents } from "./documents";
import { files } from "./file-cabinet";
import { parties } from "./parties";
import { accounts } from "./coa";
import { users } from "./extension";

/**
 * One scanned receipt on one expense report: the retained file and hash,
 * the provider reading with per-field confidence and evidence, the review
 * issues and draft line, and the reviewer's confirmation. A reading becomes
 * an expense line only through the confirmation recorded with the report's
 * line save. Deleting a draft report detaches its captures; purging a
 * discarded capture's file clears the file reference.
 */
export const expenseReceiptCaptures = pgTable(
  "expense_receipt_captures",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id"),
    fileId: uuid("file_id"),
    contentHash: text("content_hash").notNull(),
    originalFilename: text("original_filename").notNull(),
    status: text("status", {
      enum: ["extracting", "extracted", "failed", "confirmed", "discarded"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    provider: text("provider", { enum: ["azure_document_intelligence", "llm_vision"] }).notNull(),
    model: text("model").notNull(),
    apiVersion: text("api_version").notNull(),
    normalized: jsonb("normalized").$type<Record<string, unknown>>(),
    evidence: jsonb("evidence")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    issues: jsonb("issues")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    draft: jsonb("draft").$type<Record<string, unknown>>(),
    overallConfidence: numeric("overall_confidence", { precision: 5, scale: 4 }),
    /** Receipt identity for duplicate detection: the confident reading, then the reviewer's values. */
    merchantKey: text("merchant_key"),
    merchantPartyId: uuid("merchant_party_id"),
    transactionDate: date("transaction_date"),
    currency: text("currency"),
    total: money("total"),
    lastError: text("last_error"),
    confirmedLineNumber: integer("confirmed_line_number"),
    confirmedAccountId: uuid("confirmed_account_id"),
    confirmedAmount: money("confirmed_amount"),
    confirmedTaxAmount: money("confirmed_tax_amount"),
    confirmedMerchantName: text("confirmed_merchant_name"),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    discardedBy: uuid("discarded_by").references(() => users.id),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("expense_receipt_captures_org_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "expense_receipt_captures_document_fk",
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    foreignKey({
      name: "expense_receipt_captures_file_fk",
      columns: [t.orgId, t.fileId],
      foreignColumns: [files.orgId, files.id],
    }),
    foreignKey({
      name: "expense_receipt_captures_merchant_party_fk",
      columns: [t.orgId, t.merchantPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "expense_receipt_captures_confirmed_account_fk",
      columns: [t.orgId, t.confirmedAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    index("expense_receipt_captures_document").on(t.orgId, t.documentId),
    index("expense_receipt_captures_content_hash").on(t.orgId, t.contentHash),
    index("expense_receipt_captures_receipt_identity").on(
      t.orgId,
      t.merchantKey,
      t.transactionDate,
    ),
    index("expense_receipt_captures_file").on(t.orgId, t.fileId),
    check(
      "expense_receipt_captures_status",
      sql`${t.status} in ('extracting','extracted','failed','confirmed','discarded')`,
    ),
    check("expense_receipt_captures_hash", sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
);
