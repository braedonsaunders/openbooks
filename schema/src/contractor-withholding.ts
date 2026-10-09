import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * A legal entity registered as a contractor under a pack-declared withholding
 * scheme (UK CIS, German Bauabzugsteuer, Irish RCT) for an effective period.
 */
export const withholdingEnrollments = pgTable(
  "withholding_enrollments",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    schemeCode: text("scheme_code").notNull(),
    contractorReference: text("contractor_reference").notNull(),
    liabilityAccountId: uuid("liability_account_id").notNull(),
    authorityPartyId: uuid("authority_party_id"),
    thresholdBasis: text("threshold_basis"),
    payerScope: text("payer_scope"),
    returnFrequency: text("return_frequency", { enum: ["monthly","quarterly","annual"] }),
    remittanceScheduleCode: text("remittance_schedule_code"),
    remittancePolicy: jsonb("remittance_policy"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("withholding_enrollments_org_id_id_key").on(t.orgId, t.id)],
);

/** A subcontractor's band for one paying legal entity and its supporting verification. */
export const withholdingStandings = pgTable(
  "withholding_standings",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id"),
    partyId: uuid("party_id").notNull(),
    schemeCode: text("scheme_code").notNull(),
    bandCode: text("band_code").notNull(),
    verificationReference: text("verification_reference"),
    verifiedOn: date("verified_on"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    payeeReference: text("payee_reference"),
    payeeTaxOffice: text("payee_tax_office"),
    applyFromFirstPayment: boolean("apply_from_first_payment").notNull().default(false),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    revokedReason: text("revoked_reason"),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("withholding_standings_org_id_id_key").on(t.orgId, t.id),
    index("withholding_standings_party").on(t.orgId, t.subsidiaryId, t.partyId, t.schemeCode, t.validFrom),
  ],
);

/** Tax deducted from one payment application, as computed and posted. */
export const withholdingDeductions = pgTable(
  "withholding_deductions",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    enrollmentId: uuid("enrollment_id").notNull(),
    standingId: uuid("standing_id"),
    payeeName: text("payee_name").notNull(),
    payeeReference: text("payee_reference"),
    verificationReference: text("verification_reference"),
    schemeCode: text("scheme_code").notNull(),
    partyId: uuid("party_id").notNull(),
    paymentDocumentId: uuid("payment_document_id").notNull(),
    billDocumentId: uuid("bill_document_id").notNull(),
    billOpenLineId: uuid("bill_open_line_id").notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    paymentDate: date("payment_date").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    currency: currencyCode("currency").notNull(),
    bandCode: text("band_code").notNull(),
    ratePercent: numeric("rate_percent", { precision: 9, scale: 4 }).notNull(),
    downgradedFrom: text("downgraded_from"),
    paidAmount: money("paid_amount").notNull(),
    netAmount: money("net_amount").notNull(),
    materialsAmount: money("materials_amount").notNull(),
    vatAmount: money("vat_amount").notNull(),
    considerationAmount: money("consideration_amount").notNull(),
    baseAmount: money("base_amount").notNull(),
    catchUpBase: money("catch_up_base").notNull().default("0"),
    deductedAmount: money("deducted_amount").notNull(),
    uncollectedAmount: money("uncollected_amount").notNull().default("0"),
    transactionCurrency: currencyCode("transaction_currency"),
    transactionPaidAmount: money("transaction_paid_amount"),
    transactionDeductedAmount: money("transaction_deducted_amount"),
    reportingFxRate: numeric("reporting_fx_rate", { precision: 19, scale: 10 }),
    reportingFxEvidence: jsonb("reporting_fx_evidence"),
    belowThreshold: boolean("below_threshold").notNull().default(false),
    authorisationReference: text("authorisation_reference"),
    reasons: jsonb("reasons").notNull().default([]),
    status: text("status", { enum: ["posted", "voided"] }).notNull().default("posted"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("withholding_deductions_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("withholding_deductions_payment_line_key").on(t.orgId, t.paymentDocumentId, t.billOpenLineId),
    index("withholding_deductions_payee_year").on(t.orgId, t.partyId, t.schemeCode, t.paymentDate),
    check("withholding_deductions_fx_evidence_complete", sql`num_nonnulls(${t.transactionCurrency},${t.transactionPaidAmount},${t.transactionDeductedAmount},${t.reportingFxRate},${t.reportingFxEvidence}) IN (0,5)`),
    check("withholding_deductions_transaction_amounts", sql`${t.transactionPaidAmount} >= 0 AND ${t.transactionDeductedAmount} >= 0 AND ${t.transactionDeductedAmount} <= ${t.transactionPaidAmount} AND ${t.reportingFxRate} > 0`),
    check("withholding_deductions_fx_evidence_scope", sql`${t.reportingFxEvidence} IS NULL OR (jsonb_typeof(${t.reportingFxEvidence})='object' AND ${t.reportingFxEvidence}->>'kind'='as-of' AND ${t.reportingFxEvidence}->>'from'=${t.transactionCurrency} AND ${t.reportingFxEvidence}->>'to'=${t.currency} AND ${t.reportingFxEvidence}->>'asOf'=${t.paymentDate}::text AND ${t.reportingFxEvidence}->>'policy'='direct-or-inverse-spot' AND ${t.reportingFxEvidence}->>'table'='fx_rates' AND ${t.reportingFxEvidence}->>'digest' ~ '^[a-f0-9]{64}$' AND (${t.reportingFxEvidence}->>'rate')::numeric=${t.reportingFxRate} AND jsonb_typeof(${t.reportingFxEvidence}->'observations')='array' AND (${t.reportingFxEvidence}->>'sameCurrencyPar')::boolean=(${t.transactionCurrency}=${t.currency})) IS TRUE`),
  ],
);

/** A periodic withholding return frozen from posted deductions. */
export const withholdingReturns = pgTable(
  "withholding_returns",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    enrollmentId: uuid("enrollment_id").notNull(),
    schemeCode: text("scheme_code").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status", { enum: ["prepared", "filed", "superseded"] }).notNull().default("prepared"),
    currency: currencyCode("currency").notNull(),
    totals: jsonb("totals").notNull(),
    lines: jsonb("lines").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    preparedBy: uuid("prepared_by").notNull(),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    filedBy: uuid("filed_by"),
    filingReference: text("filing_reference"),
    remittanceDocumentId: uuid("remittance_document_id"),
  },
  (t) => [
    uniqueIndex("withholding_returns_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("withholding_returns_period_revision_key").on(t.orgId, t.enrollmentId, t.periodStart, t.revision),
  ],
);
