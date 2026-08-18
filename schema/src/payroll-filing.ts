import { sql } from "drizzle-orm";
import {
  boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Payroll filing (remittance) accounts.
 *
 * One employer is rarely one filing identity. A Canadian business number
 * carries several payroll program accounts (…RP0001, …RP0002) — divisions that
 * remit, file T4s, and receive PD7A statements separately. The US equivalent is
 * several EINs plus a per-state unemployment (SUI) account per state the
 * employer is registered in. Other packs declare their own identities (an
 * HMRC PAYE reference, an ATO branch number) without touching this table.
 *
 * Doctrine:
 * - The account is the FILING identity, never a second wage/statutory rule
 *   source: the engines still compute from the employee's country pack.
 * - Employees are assigned one account (employee_payroll_profiles.filing_account_id);
 *   remittance summaries, PD7A worksheets, and the year-end returns group by it.
 * - `country` and `program_type` are OPEN text, validated at the API boundary
 *   against the pack's declared filing program types
 *   (engine/src/payroll-filing-registry.ts `filingAccountProblem`). They were
 *   CHECK-constrained to CA/US literals, which made the deliberately open pack
 *   registry a lie: a registered pack's accounts were unrepresentable. A DB
 *   CHECK cannot enumerate an open registry, so the pack declaration is the
 *   single source of truth and the constraint lives where the declaration is.
 * - `remitter_type` is the CRA remittance frequency the account is registered
 *   under. It is filing metadata carried onto remittance groups; the due-date
 *   calendar for the accelerated thresholds needs a statutory working-day
 *   calendar and is not derived from it yet.
 */
export const payrollFilingAccounts = pgTable(
  "payroll_filing_accounts",
  {
    id: id(),
    orgId: orgRef(),
    /** Country pack the account files under; matches the employees' profile country. */
    country: text("country").notNull(),
    /**
     * Which of the pack's declared filing identities this is ("ca_rp",
     * "us_ein", "us_state_sui", or whatever a registered pack declares).
     */
    programType: text("program_type").notNull(),
    /** The registered number as the agency writes it ("123456789RP0002"). */
    accountNumber: text("account_number").notNull(),
    name: text("name").notNull(),
    /**
     * CRA remitter type — the frequency the account is registered under.
     * 'regular' (15th of the following month), 'quarterly' (small employers),
     * and the two accelerated thresholds for larger payrolls.
     */
    remitterType: text("remitter_type", {
      enum: ["regular", "quarterly", "accelerated_1", "accelerated_2"],
    }).notNull().default("regular"),
    /** Legal entity that files this account; null = org-wide (root subsidiary). */
    subsidiaryId: uuid("subsidiary_id"),
    /** State/region postal code — required exactly when the pack's program
     *  type declares `requiresRegion` (a per-state SUI account). */
    stateCode: text("state_code"),
    /** Assigned to employees whose profile names no account, per country. */
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_filing_accounts_org_number").on(t.orgId, t.accountNumber),
    index("payroll_filing_accounts_org_country").on(t.orgId, t.country, t.programType),
    // At most one default per country pack, so the fallback assignment is
    // never ambiguous.
    uniqueIndex("payroll_filing_accounts_org_default")
      .on(t.orgId, t.country)
      .where(sql`is_default`),
  ],
);

/**
 * Tenant-entered statutory RATES, at the scope the country pack says each one
 * varies by (engine/src/payroll/statutory-rates.ts).
 *
 * Most statutory arithmetic is published and lives in the pack's own edition
 * modules, where no tenant can touch it. A minority is not published, or is
 * published per employer account or per region, and those were stored as a
 * single org-level blob in `orgs.settings.payroll` — which could hold exactly
 * ONE value for a number that legitimately has several:
 *
 * - a state unemployment rate is experience-rated per REGISTERED ACCOUNT, so a
 *   two-EIN employer in one state has two of them;
 * - the FUTA credit reduction is published per STATE per YEAR, so one employer
 *   owes two different effective rates in one payroll and Form 940 Schedule A
 *   is computed state by state;
 * - employer health levies are per PROVINCE, at each province's own rate and
 *   exemption.
 *
 * Doctrine:
 * - `country` and `rate_key` are OPEN text, validated at the API boundary
 *   against the pack's declared rate slots (`statutoryRateProblem`), for the
 *   same reason `program_type` is: a DB CHECK cannot enumerate an open pack
 *   registry, so the constraint lives with the declaration.
 * - which key columns a row carries is the SLOT's declared scope: org-wide
 *   (neither), per region (`region`), per account (`region` +
 *   `filing_account_id`, or `region` alone as the account-wide default a
 *   single-account employer keeps using).
 * - `tax_year` is the effective dimension, because that is the granularity
 *   every one of these rates is actually assigned at — a state's annual rate
 *   notice, USDOL's annual credit-reduction determination, a province's annual
 *   exemption. Re-running a prior period therefore reproduces that period's
 *   rate instead of reinterpreting it with this year's.
 * - values live in `rate_values` keyed by the slot's declared field keys, each
 *   canonicalized to that field's declared scale before it is stored.
 */
export const payrollStatutoryRates = pgTable(
  "payroll_statutory_rates",
  {
    id: id(),
    orgId: orgRef(),
    /** Country pack that declares the rate slot. */
    country: text("country").notNull(),
    /** The pack's declared slot key ("us_sui", "us_futa", "ca_eht"). */
    rateKey: text("rate_key").notNull(),
    /** Province/state the rate applies in; null only for an org-wide slot. */
    region: text("region"),
    /**
     * The taxing unit BELOW the region, for a slot the pack declares at
     * `sub_region` scope — a Pennsylvania Act 32 PSD code, an Ohio
     * municipality, a Michigan city. Null for every other scope.
     *
     * It is part of the uniqueness point below, not merely a label: without it
     * two municipalities' rates occupy the same scope point and `resolve()`
     * silently answers with whichever row the planner returns first.
     */
    subRegion: text("sub_region"),
    /**
     * The filing account the rate is assigned to, for a slot the pack declares
     * per account. Null = the region-wide value every account uses, which is
     * what a single-account employer configures.
     */
    filingAccountId: uuid("filing_account_id"),
    /** The tax year the rate was assigned for. */
    taxYear: integer("tax_year").notNull(),
    /** { [fieldKey]: canonical decimal string } per the slot's declaration. */
    rateValues: jsonb("rate_values").notNull(),
    ...auditColumns,
  },
  (t) => [
    // One row per scope point. Two rows for the same point would make the
    // resolution ambiguous, and an ambiguous statutory rate is wrong money that
    // changes answer between queries.
    uniqueIndex("payroll_statutory_rates_org_point").on(
      t.orgId, t.country, t.rateKey, t.taxYear,
      sql`coalesce(region, '')`,
      sql`coalesce(sub_region, '')`,
      sql`coalesce(filing_account_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    check("payroll_statutory_rates_sub_region",
      sql`${t.subRegion} is null or ${t.region} is not null`),
    index("payroll_statutory_rates_org_year").on(t.orgId, t.country, t.taxYear),
    index("payroll_statutory_rates_account").on(t.orgId, t.filingAccountId),
  ],
);

/**
 * ISSUED filings — the original → amended → cancelled lifecycle.
 *
 * A statutory filing is not a report you can re-run: once a T4, a W-2 or a
 * Form 941 has gone to the agency it is EVIDENCE of what the employer
 * declared, and every employer eventually declares something wrong (a missed
 * taxable benefit, a wrong SIN, an employee who was on the wrong entity).
 *
 * Doctrine:
 * - An amendment is a NEW row that supersedes the previous one. Nothing ever
 *   updates an issued submission; overwriting the artifact would destroy the
 *   only record of what the agency actually received.
 * - `revision` is the AGENCY-NEUTRAL state. Each pack maps it onto its own
 *   mechanics — the CRA stamps a report-type code (O/A/C) on the same T4 XML,
 *   the IRS uses a wholly separate correction form (W-2c, 941-X). The generic
 *   layer branches on nothing.
 * - `artifact_body` is the exact bytes transmitted, so the file can be
 *   re-produced byte for byte years later. It is null for a filing with no
 *   electronic file (a W-2 keyed into SSA BSO, a paper 941) — the slip
 *   snapshots are then the evidence.
 * - AMEND and CANCEL are different operations, not two flavours of edit:
 *   amending restates a slip that should exist, cancelling says the slip
 *   should never have existed. Agencies treat them differently; so does this.
 */
export const payrollFilingSubmissions = pgTable(
  "payroll_filing_submissions",
  {
    id: id(),
    orgId: orgRef(),
    /** Country pack whose registry declares the filing. */
    country: text("country").notNull(),
    /** The pack's own filing key ("t4", "w2", "941", "rl1", "p60"). */
    filingKey: text("filing_key").notNull(),
    taxYear: integer("tax_year").notNull(),
    revision: text("revision", {
      enum: ["original", "amended", "cancelled"],
    }).notNull(),
    /** 1, 2, 3 … in issue order for the filing-year; the original is 1. */
    revisionNumber: integer("revision_number").notNull(),
    /** The artifact this one supersedes; null on the original. */
    supersedesId: uuid("supersedes_id"),
    /**
     * When the employer states the artifact went to the agency — distinct
     * from created_at, because a filing is routinely recorded after the fact.
     */
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    slipCount: integer("slip_count").notNull().default(0),
    artifactFilename: text("artifact_filename"),
    artifactContentType: text("artifact_content_type"),
    artifactBody: text("artifact_body"),
    ...auditColumns,
  },
  (t) => [
    // Two artifacts claiming to be revision 2 make "what superseded what"
    // ambiguous, and an ambiguous filing history is not an audit trail.
    uniqueIndex("payroll_filing_submissions_org_revision")
      .on(t.orgId, t.country, t.filingKey, t.taxYear, t.revisionNumber),
    index("payroll_filing_submissions_org_filing")
      .on(t.orgId, t.country, t.filingKey, t.taxYear, t.issuedAt.desc()),
  ],
);

/**
 * What ONE row of a filing reported on ONE issued artifact.
 *
 * This is the "previously reported" column the IRS's W-2c and 941-X print,
 * and it is what the delta an operator reviews is computed against. It holds
 * exactly what the SLIP printed — box codes, labels and values in the form's
 * own vocabulary — plus keyed FINGERPRINTS of confidential identity facts:
 * a wrong SIN/SSN is one of the commonest reasons to amend, and the
 * fingerprint proves the number changed without the number ever being stored
 * outside the sealed profile column.
 */
export const payrollFilingSubmissionSlips = pgTable(
  "payroll_filing_submission_slips",
  {
    id: id(),
    orgId: orgRef(),
    submissionId: uuid("submission_id").notNull(),
    /** The filing population's own rowKey value — opaque to generic code. */
    rowId: text("row_id").notNull(),
    /** The row's first declared column, so history reads without re-querying. */
    label: text("label").notNull(),
    revision: text("revision", {
      enum: ["original", "amended", "cancelled"],
    }).notNull(),
    /** { fields: [{code,label,value}], confidential: [{label,fingerprint}] } */
    reported: jsonb("reported").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_filing_submission_slips_row").on(t.submissionId, t.rowId),
    index("payroll_filing_submission_slips_org_row").on(t.orgId, t.rowId),
  ],
);

// Foreign keys are maintained in the migration (DEFERRABLE, per house rule).
