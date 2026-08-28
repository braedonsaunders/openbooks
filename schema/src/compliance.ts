import { sql } from "drizzle-orm";
import {
  boolean,
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
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Subcontractor compliance — the controls a general contractor runs on the
 * people it pays: certificates of insurance, licences and bonds; lien waivers
 * exchanged for payment; and year-end information returns (1099-NEC/MISC,
 * T4A).
 *
 * The module is deliberately POLICY-FIRST. Nothing here is hardcoded:
 *
 *   compliance_classes       what kind of counterparty this is (trade sub,
 *                            material supplier, consultant…) and what payment
 *                            control that class carries.
 *   compliance_requirements  one row per policy: "Trade Subcontractors must
 *                            carry $2,000,000 General Liability, naming us as
 *                            additional insured, and we block payment when it
 *                            lapses." One row = one policy, so there is exactly
 *                            one source of truth for every enforced value.
 *   compliance_records       the evidence on file against a requirement (the
 *                            actual COI), with issuer, limits and expiry. The
 *                            certificate FILE itself lives in the File Cabinet
 *                            and links here through file_attachments
 *                            (target_table = 'compliance_records').
 *   compliance_waivers       an explicit, approved, EXPIRING exception. The only
 *                            legitimate way past a blocking requirement.
 *   compliance_release_checks the immutable evidence of a payment-release
 *                            decision: what the policy was, what was on file,
 *                            and who released it anyway.
 *   lien_waivers             conditional/unconditional, progress/final waivers
 *                            received from subcontractors or issued to owners.
 *   information_return_*     1099-NEC / 1099-MISC / T4A filings, their
 *                            recipients, and the account→box mapping that
 *                            decides which box a payment lands in.
 *
 * Enforcement is evaluated as-of the moment of a payment decision and then
 * SNAPSHOTTED into compliance_release_checks, so tightening a policy tomorrow
 * never reinterprets a release granted today. That is why the policy rows
 * themselves are not effective-dated.
 */

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

/**
 * Counterparty classification. A vendor's class decides which requirements
 * apply to it and whether a lien waiver has to be in hand before its money is
 * released. Classes are org-authored (Setup → Compliance).
 */
export const complianceClasses = pgTable(
  "compliance_classes",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Lien-waiver control for this class:
     *   none  — waivers are not tracked for these vendors
     *   warn  — a missing waiver is surfaced, payment still allowed
     *   block — a bill cannot be paid until a signed waiver covers it
     */
    lienWaiverEnforcement: text("lien_waiver_enforcement", {
      enum: ["none", "warn", "block"],
    })
      .notNull()
      .default("none"),
    /** Waiver form to request by default (see lien_waivers.waiver_type). */
    defaultLienWaiverType: text("default_lien_waiver_type", {
      enum: [
        "conditional_progress",
        "unconditional_progress",
        "conditional_final",
        "unconditional_final",
      ],
    }),
    /**
     * Default information return for vendors in this class. Individual vendors
     * override on the vendor record; 'none' means not reportable.
     */
    defaultInformationReturn: text("default_information_return", {
      enum: ["none", "1099-NEC", "1099-MISC", "T4A"],
    })
      .notNull()
      .default("none"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("compliance_classes_org_code").on(t.orgId, t.code)],
);

/**
 * One compliance policy. `class_id` null = applies to every tracked vendor;
 * otherwise the policy applies to that class only. Want the same certificate
 * demanded of two classes with different limits? That is two rows — which is
 * the point: each enforced number has exactly one home.
 */
export const complianceRequirements = pgTable(
  "compliance_requirements",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** What kind of evidence this is (drives the record form + reporting). */
    category: text("category", {
      enum: ["insurance", "tax_form", "licence", "bond", "safety", "other"],
    })
      .notNull()
      .default("insurance"),
    /** null = every tracked vendor; else scoped to one class. */
    classId: uuid("class_id"),
    /** Evidence must carry an expiry date (true for insurance, false for a W-9). */
    requiresExpiry: boolean("requires_expiry").notNull().default(true),
    /** Minimum per-occurrence limit the certificate must show; null = unchecked. */
    minCoverageAmount: money("min_coverage_amount"),
    /** Minimum aggregate limit; null = unchecked. */
    minAggregateAmount: money("min_aggregate_amount"),
    /** Currency the minimums are expressed in (defaults to the org's base). */
    coverageCurrency: currencyCode("coverage_currency"),
    requiresAdditionalInsured: boolean("requires_additional_insured").notNull().default(false),
    requiresWaiverOfSubrogation: boolean("requires_waiver_of_subrogation").notNull().default(false),
    requiresPrimaryNoncontributory: boolean("requires_primary_noncontributory")
      .notNull()
      .default(false),
    /**
     * What a failure does:
     *   advisory      — reported only
     *   warn          — surfaced on the pay run, payment allowed
     *   block_payment — the vendor's bills cannot be selected or paid
     *   block_bill    — the vendor's bills cannot be posted at all
     */
    enforcement: text("enforcement", {
      enum: ["advisory", "warn", "block_payment", "block_bill"],
    })
      .notNull()
      .default("warn"),
    /** Days after expiry before enforcement bites (a courtesy window). */
    graceDays: integer("grace_days").notNull().default(0),
    /** Days before expiry the certificate starts reporting as expiring. */
    expiryWarningDays: integer("expiry_warning_days").notNull().default(30),
    /** Evidence must be verified by a second person before it counts. */
    requiresVerification: boolean("requires_verification").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("compliance_requirements_org_code").on(t.orgId, t.code),
    index("compliance_requirements_org_class").on(t.orgId, t.classId),
  ],
);

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * A certificate / form on file for one vendor against one requirement.
 *
 * Renewals are new rows, not edits: the prior row keeps its dates and its
 * verification trail and points forward through `superseded_by_id`. The
 * resolver always evaluates the row with the furthest coverage.
 */
export const complianceRecords = pgTable(
  "compliance_records",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    requirementId: uuid("requirement_id").notNull(),
    /** Project-specific certificate (an OCIP/wrap policy); null = vendor-wide. */
    projectId: uuid("project_id"),
    /**
     * Lifecycle only — whether the evidence is currently in force is DERIVED
     * from the dates, never stored (a nightly job would otherwise be the source
     * of truth for a control).
     */
    status: text("status", {
      enum: ["pending_review", "active", "rejected", "superseded"],
    })
      .notNull()
      .default("pending_review"),
    issuerName: text("issuer_name"),
    policyNumber: text("policy_number"),
    effectiveFrom: date("effective_from").notNull(),
    /** Null only when the requirement does not require an expiry. */
    expiresOn: date("expires_on"),
    coverageAmount: money("coverage_amount"),
    aggregateAmount: money("aggregate_amount"),
    coverageCurrency: currencyCode("coverage_currency"),
    additionalInsured: boolean("additional_insured").notNull().default(false),
    waiverOfSubrogation: boolean("waiver_of_subrogation").notNull().default(false),
    primaryNoncontributory: boolean("primary_noncontributory").notNull().default(false),
    /** Second-person verification (segregation of duties from whoever uploaded). */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by"),
    rejectedReason: text("rejected_reason"),
    supersededById: uuid("superseded_by_id"),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    index("compliance_records_party").on(t.orgId, t.partyId, t.requirementId),
    index("compliance_records_expiry").on(t.orgId, t.expiresOn),
    index("compliance_records_project").on(t.orgId, t.projectId),
  ],
);

/**
 * An approved exception to a requirement for one vendor. Always has a reason,
 * always expires, and revocation is recorded rather than deleted — a waiver is
 * a control override and has to read like one in the audit trail.
 */
export const complianceWaivers = pgTable(
  "compliance_waivers",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    requirementId: uuid("requirement_id").notNull(),
    /** Scope the exception to one project; null = the whole vendor. */
    projectId: uuid("project_id"),
    reason: text("reason").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** Mandatory: an exception without an end date is a policy change. */
    expiresOn: date("expires_on").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid("approved_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason"),
    ...auditColumns,
  },
  (t) => [
    index("compliance_waivers_party").on(t.orgId, t.partyId, t.requirementId),
    index("compliance_waivers_window").on(t.orgId, t.expiresOn),
  ],
);

/**
 * Immutable evidence of a payment-release decision. Written whenever a bill is
 * selected into a pay run, when a run is checked for readiness, and when a run
 * posts — including the full policy/evidence snapshot that produced it. This is
 * the record an auditor reads to see that the control ran, and who overrode it.
 */
export const complianceReleaseChecks = pgTable(
  "compliance_release_checks",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    /** The bill being released (null for run-level checks). */
    documentId: uuid("document_id"),
    paymentRunId: uuid("payment_run_id"),
    paymentInstructionId: uuid("payment_instruction_id"),
    stage: text("stage", { enum: ["run_created", "readiness", "run_posted", "manual"] }).notNull(),
    decision: text("decision", { enum: ["cleared", "warned", "blocked", "overridden"] }).notNull(),
    /** Frozen evaluation: requirements, evidence, waivers, lien-waiver coverage. */
    snapshot: jsonb("snapshot").notNull().default({}),
    /** Present only on 'overridden': who accepted the risk and why. */
    overrideReason: text("override_reason"),
    overriddenBy: uuid("overridden_by"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    checkedBy: uuid("checked_by"),
  },
  (t) => [
    index("compliance_release_checks_party").on(t.orgId, t.partyId, t.checkedAt),
    index("compliance_release_checks_run").on(t.orgId, t.paymentRunId),
    index("compliance_release_checks_document").on(t.orgId, t.documentId),
  ],
);

// ---------------------------------------------------------------------------
// Lien waivers
// ---------------------------------------------------------------------------

/**
 * A lien waiver — the statutory release exchanged for construction payment.
 *
 * `direction = 'received'` are waivers we collect from subcontractors before
 * releasing their money; `'issued'` are the ones we sign for an owner or
 * upstream contractor in exchange for ours. Not a posting document: no journal
 * entry, no lines. It carries the amount and the through-date it releases, and
 * the payment control reads exactly those two fields.
 */
export const lienWaivers = pgTable(
  "lien_waivers",
  {
    id: id(),
    orgId: orgRef(),
    waiverNumber: text("waiver_number").notNull(),
    direction: text("direction", { enum: ["received", "issued"] }).notNull(),
    /** Subcontractor (received) or owner/upstream contractor (issued). */
    partyId: uuid("party_id").notNull(),
    projectId: uuid("project_id").notNull(),
    waiverType: text("waiver_type", {
      enum: [
        "conditional_progress",
        "unconditional_progress",
        "conditional_final",
        "unconditional_final",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["draft", "requested", "received", "signed", "rejected", "void"],
    })
      .notNull()
      .default("draft"),
    /** Work performed through this date is released by the waiver. */
    throughDate: date("through_date").notNull(),
    /** Amount released. Payment control compares released vs. requested cash. */
    amount: money("amount").notNull().default("0"),
    currency: currencyCode("currency").notNull(),
    /** Jurisdiction whose statutory form this follows (e.g. 'US-CA', 'CA-ON'). */
    jurisdiction: text("jurisdiction"),
    /** The vendor bill this waiver covers (received) — optional but usual. */
    billDocumentId: uuid("bill_document_id"),
    /** The vendor payment that released against it (set when the run posts). */
    paymentDocumentId: uuid("payment_document_id"),
    /** The application for payment this waiver accompanies (issued). */
    payApplicationId: uuid("pay_application_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    requestedBy: uuid("requested_by"),
    /** Signature evidence — same HMAC-token scheme as field-ticket signing. */
    signedByName: text("signed_by_name"),
    signedByTitle: text("signed_by_title"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signature: jsonb("signature"),
    notarized: boolean("notarized").notNull().default(false),
    rejectedReason: text("rejected_reason"),
    voidReason: text("void_reason"),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("lien_waivers_org_number").on(t.orgId, t.waiverNumber),
    index("lien_waivers_party").on(t.orgId, t.partyId, t.throughDate),
    index("lien_waivers_project").on(t.orgId, t.projectId, t.status),
    index("lien_waivers_bill").on(t.orgId, t.billDocumentId),
  ],
);

// ---------------------------------------------------------------------------
// Information returns (1099-NEC / 1099-MISC / T4A)
// ---------------------------------------------------------------------------

/**
 * Which box a payment lands in, decided by the expense account it funded.
 * A vendor's default box covers everything unmapped, so an org that puts all
 * subcontract cost in box 1 configures nothing at all.
 */
export const informationReturnBoxRules = pgTable(
  "information_return_box_rules",
  {
    id: id(),
    orgId: orgRef(),
    formType: text("form_type", { enum: ["1099-NEC", "1099-MISC", "T4A"] }).notNull(),
    /** Stable box key, e.g. 'nec1', 'misc1' (rents), 'misc3' (other income). */
    box: text("box").notNull(),
    /** Expense/COGS account whose spend routes to this box. */
    accountId: uuid("account_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("information_return_box_rules_unique").on(t.orgId, t.formType, t.accountId),
    index("information_return_box_rules_form").on(t.orgId, t.formType, t.box),
  ],
);

/** One year's filing of one form type: the payer snapshot and its lifecycle. */
export const informationReturnFilings = pgTable(
  "information_return_filings",
  {
    id: id(),
    orgId: orgRef(),
    taxYear: integer("tax_year").notNull(),
    formType: text("form_type", { enum: ["1099-NEC", "1099-MISC", "T4A"] }).notNull(),
    /** Filing entity when the org runs several (null = org root). */
    subsidiaryId: uuid("subsidiary_id"),
    status: text("status", { enum: ["draft", "computed", "finalized", "filed", "void"] })
      .notNull()
      .default("draft"),
    /** Reporting threshold; recipients below it are excluded by default. */
    threshold: money("threshold").notNull().default("600"),
    currency: currencyCode("currency").notNull(),
    /**
     * Payer identification frozen at finalize time — the filing must reproduce
     * exactly what was transmitted even after the org record changes.
     */
    payerSnapshot: jsonb("payer_snapshot").notNull().default({}),
    computedAt: timestamp("computed_at", { withTimezone: true }),
    computedBy: uuid("computed_by"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: uuid("finalized_by"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    filedBy: uuid("filed_by"),
    filingChannel: text("filing_channel", { enum: ["iris", "fire", "paper", "provider", "other"] }),
    filingReference: text("filing_reference"),
    voidReason: text("void_reason"),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    // PostgreSQL's normal unique-index semantics treat NULL subsidiary IDs as
    // distinct. Keep root filings unique with a dedicated partial index, while
    // preserving one filing per subsidiary in the non-null scope.
    uniqueIndex("information_return_filings_unique_root")
      .on(t.orgId, t.taxYear, t.formType)
      .where(sql`${t.subsidiaryId} IS NULL`),
    uniqueIndex("information_return_filings_unique_sub")
      .on(t.orgId, t.taxYear, t.formType, t.subsidiaryId)
      .where(sql`${t.subsidiaryId} IS NOT NULL`),
    index("information_return_filings_org").on(t.orgId, t.taxYear),
  ],
);

/**
 * One recipient line of a filing. `computed_amounts` is what the ledger says;
 * `adjustments` is what a human deliberately changed and why. The filed figure
 * is always computed + adjustment, so the ledger trace is never overwritten.
 */
export const informationReturnRecipients = pgTable(
  "information_return_recipients",
  {
    id: id(),
    orgId: orgRef(),
    filingId: uuid("filing_id").notNull(),
    partyId: uuid("party_id").notNull(),
    /** Name/TIN/address frozen at compute time (box-for-box what we transmit). */
    recipientSnapshot: jsonb("recipient_snapshot").notNull().default({}),
    /** Masked TIN for display; the full value stays sealed on the vendor role. */
    tinLast4: text("tin_last4"),
    tinType: text("tin_type", { enum: ["ssn", "ein", "itin", "atin", "sin", "bn", "unknown"] }),
    /** Box key → exact-decimal amount, straight from the ledger trace. */
    computedAmounts: jsonb("computed_amounts").notNull().default({}),
    /** Box key → signed exact-decimal correction entered by a person. */
    adjustments: jsonb("adjustments").notNull().default({}),
    adjustmentReason: text("adjustment_reason"),
    /** Federal/other income tax withheld and remitted on the recipient's behalf. */
    taxWithheld: money("tax_withheld").notNull().default("0"),
    /** Per-jurisdiction state/provincial withholding detail. */
    stateWithholding: jsonb("state_withholding").notNull().default({}),
    status: text("status", { enum: ["included", "excluded", "corrected", "void"] })
      .notNull()
      .default("included"),
    /** Why this recipient is not being filed (below threshold, corporation…). */
    exclusionReason: text("exclusion_reason"),
    /** The recipient row this one corrects (a 'CORRECTED' form). */
    correctedFromId: uuid("corrected_from_id"),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    furnishedAt: timestamp("furnished_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("information_return_recipients_unique").on(t.filingId, t.partyId),
    index("information_return_recipients_filing").on(t.orgId, t.filingId, t.status),
    index("information_return_recipients_party").on(t.orgId, t.partyId),
  ],
);
