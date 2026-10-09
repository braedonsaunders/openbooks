import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { paymentRuns } from "./banking";
import { auditColumns, currencyCode, fxRate, id, money, orgRef } from "./helpers";

/**
 * Tenant-owned bank file definitions. Built-in rails use audited engine
 * formatters; `custom` executes real JavaScript in the QuickJS sandbox.
 */
export const paymentFormats = pgTable(
  "payment_formats",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    rail: text("rail", {
      enum: [
        "cpa005_credit",
        "nacha_credit",
        "sepa_credit",
        "nacha_debit",
        "sepa_debit",
        "positive_pay",
        "wire",
        "cheque",
        "custom",
      ],
    }).notNull(),
    direction: text("direction", { enum: ["credit", "debit", "both"] }).notNull().default("credit"),
    country: text("country"),
    currency: currencyCode("currency"),
    fileExtension: text("file_extension").notNull().default("txt"),
    contentType: text("content_type").notNull().default("text/plain; charset=utf-8"),
    formatterScript: text("formatter_script"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payment_formats_org_code").on(t.orgId, t.code),
    index("payment_formats_org_active").on(t.orgId, t.isActive),
  ],
);

/** A tenant's funding account plus rail-specific, encrypted originator data. */
export const paymentBankProfiles = pgTable(
  "payment_bank_profiles",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    paymentFormatId: uuid("payment_format_id").notNull(),
    currency: currencyCode("currency").notNull(),
    country: text("country"),
    /** Envelope-encrypted JSON; never exposed by list/read APIs. */
    originatorSecretsEncrypted: text("originator_secrets_encrypted"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    sftpServerId: uuid("sftp_server_id"),
    sftpFolder: text("sftp_folder"),
    autoRemittance: boolean("auto_remittance").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payment_bank_profiles_org_name").on(t.orgId, t.name),
    index("payment_bank_profiles_org_active").on(t.orgId, t.isActive),
  ],
);

/** Repeatable, criteria-driven payment selection. The scheduler creates runs. */
export const paymentSchedules = pgTable(
  "payment_schedules",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    paymentBankProfileId: uuid("payment_bank_profile_id").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    selectionCriteria: jsonb("selection_criteria").$type<Record<string, unknown>>().notNull().default({}),
    action: text("action", { enum: ["create_draft", "submit_for_approval"] }).notNull().default("create_draft"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastPaymentRunId: uuid("last_payment_run_id"),
    lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t): PgTableExtraConfigValue[] => [
    // Exact organization and id key required by tenant-coherent references (0210).
    uniqueIndex("payment_schedules_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("payment_schedules_org_name").on(t.orgId, t.name),
    index("payment_schedules_due").on(t.isActive, t.nextRunAt),
    // Tenant pair required by 0212: a schedule may only name a last run of its own org.
    foreignKey({
      name: "payment_schedules_last_payment_run_id_fkey",
      columns: [t.orgId, t.lastPaymentRunId],
      foreignColumns: [paymentRuns.orgId, paymentRuns.id],
    }),
  ],
);

/** Exact source composition of a run, including discounts and credits. */
export const paymentRunItems = pgTable(
  "payment_run_items",
  {
    id: id(),
    orgId: orgRef(),
    paymentRunId: uuid("payment_run_id").notNull(),
    paymentInstructionId: uuid("payment_instruction_id"),
    sourceDocumentId: uuid("source_document_id").notNull(),
    sourceOpenLineId: uuid("source_open_line_id").notNull(),
    kind: text("kind", { enum: ["bill", "credit", "expense", "refund", "receivable"] }).notNull(),
    grossAmount: money("gross_amount").notNull(),
    discountAmount: money("discount_amount").notNull().default("0"),
    /** Contractor withholding deducted from this item at payment. */
    withholdingAmount: money("withholding_amount").notNull().default("0"),
    creditAmount: money("credit_amount").notNull().default("0"),
    /** Exact target open lines and amounts for this source credit open line. */
    creditTargetAllocations: jsonb("credit_target_allocations").$type<Array<{ toLineId: string; amount: string }>>(),
    paymentAmount: money("payment_amount").notNull(),
    currency: currencyCode("currency").notNull(),
    fxRate: fxRate("fx_rate").notNull().default("1"),
    status: text("status", { enum: ["selected", "excluded", "paid", "returned", "reversed"] })
      .notNull()
      .default("selected"),
    exclusionReason: text("exclusion_reason"),
    ...auditColumns,
  },
  (t) => [
    index("payment_run_items_run").on(t.paymentRunId),
    index("payment_run_items_instruction").on(t.paymentInstructionId),
    uniqueIndex("payment_run_items_source").on(t.paymentRunId, t.sourceOpenLineId),
    uniqueIndex("payment_run_items_live_source")
      .on(t.orgId, t.sourceOpenLineId)
      .where(sql`${t.status} = 'selected'`),
  ],
);

/** Immutable generated artifact and its reprocessing lineage. */
export const paymentFiles = pgTable(
  "payment_files",
  {
    id: id(),
    orgId: orgRef(),
    paymentRunId: uuid("payment_run_id").notNull(),
    paymentBankProfileId: uuid("payment_bank_profile_id").notNull(),
    paymentFormatId: uuid("payment_format_id").notNull(),
    parentPaymentFileId: uuid("parent_payment_file_id"),
    sequenceNumber: integer("sequence_number").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    contentHash: text("content_hash").notNull(),
    fileId: uuid("file_id").notNull(),
    fileVersionId: uuid("file_version_id").notNull(),
    paymentCount: integer("payment_count").notNull(),
    totalAmount: money("total_amount").notNull(),
    currency: currencyCode("currency").notNull(),
    status: text("status", {
      enum: ["generated", "pending_approval", "approved", "rejected", "delivered", "superseded", "voided"],
    }).notNull().default("generated"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedBy: uuid("generated_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by"),
    rejectionReason: text("rejection_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payment_files_run_sequence").on(t.paymentRunId, t.sequenceNumber),
    index("payment_files_hash").on(t.orgId, t.contentHash),
    index("payment_files_run_status").on(t.paymentRunId, t.status),
  ],
);

export const paymentFileDeliveries = pgTable(
  "payment_file_deliveries",
  {
    id: id(),
    orgId: orgRef(),
    paymentFileId: uuid("payment_file_id").notNull(),
    channel: text("channel", { enum: ["download", "sftp", "bank_api"] }).notNull(),
    targetRef: text("target_ref"),
    status: text("status", { enum: ["pending", "delivered", "failed", "acknowledged", "rejected"] })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    error: text("error"),
    response: jsonb("response").$type<Record<string, unknown>>(),
    ...auditColumns,
  },
  (t) => [index("payment_file_deliveries_file").on(t.paymentFileId, t.createdAt)],
);

/** Direct-debit authorization. A proof file may be attached from the cabinet. */
export const paymentMandates = pgTable(
  "payment_mandates",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    partyBankAccountId: uuid("party_bank_account_id").notNull(),
    scheme: text("scheme", { enum: ["nacha", "sepa_core", "sepa_b2b", "custom"] }).notNull(),
    mandateReference: text("mandate_reference").notNull(),
    status: text("status", { enum: ["pending", "active", "suspended", "revoked", "expired"] })
      .notNull()
      .default("pending"),
    signedOn: date("signed_on"),
    validFrom: date("valid_from"),
    expiresOn: date("expires_on"),
    proofFileId: uuid("proof_file_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payment_mandates_org_reference").on(t.orgId, t.mandateReference),
    index("payment_mandates_party_status").on(t.partyId, t.status),
  ],
);

/** Append-only operational audit trail for runs, files, and instructions. */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: id(),
    orgId: orgRef(),
    paymentRunId: uuid("payment_run_id").notNull(),
    paymentInstructionId: uuid("payment_instruction_id"),
    paymentFileId: uuid("payment_file_id"),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payment_events_run_time").on(t.paymentRunId, t.createdAt)],
);

/**
 * Month-end in-transit accruals for provider payouts: one row per batch and
 * period-end date with the reclass journal and its next-period reversal
 * linked. A rerun converges on the (org, batch, accrual date) key instead of
 * double-accruing.
 */
export const pspPayoutAccruals = pgTable(
  "psp_payout_accruals",
  {
    id: id(),
    orgId: orgRef(),
    batchId: uuid("batch_id").notNull(),
    accrualDate: date("accrual_date").notNull(),
    reversalDate: date("reversal_date").notNull(),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    bankAccountId: uuid("bank_account_id"),
    transitAccountId: uuid("transit_account_id"),
    subsidiaryId: uuid("subsidiary_id"),
    accrualEntryId: uuid("accrual_entry_id"),
    reversalEntryId: uuid("reversal_entry_id"),
    status: text("status", { enum: ["accrued", "reversed"] }).notNull().default("accrued"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("psp_payout_accruals_batch_once").on(t.orgId, t.batchId, t.accrualDate),
    index("psp_payout_accruals_batch").on(t.batchId),
    index("psp_payout_accruals_org_status").on(t.orgId, t.status),
  ],
);
