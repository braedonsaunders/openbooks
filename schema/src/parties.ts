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
import type { InvoicingPreference } from "./project-types";

/**
 * One party model. A party is a real-world person or company; ROLES make it
 * a customer, vendor, and/or employee. source platform's separate entity tables
 * force duplicate records (and duplicate bank details, addresses, contacts)
 * when one company is both customer and vendor.
 */
export const parties = pgTable(
  "parties",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: ["company", "person"] }).notNull(),
    displayName: text("display_name").notNull(),
    legalName: text("legal_name"),
    shortCode: text("short_code"), // concise organization-defined display code
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    taxIds: jsonb("tax_ids").$type<Record<string, string>>().default({}),
    /**
     * Primary subsidiary (null = org root). Additional subsidiaries the party
     * may transact with live in party_subsidiaries (multi-subsidiary entities).
     * Employees are always single-subsidiary (primary only).
     */
    subsidiaryId: uuid("subsidiary_id"),
    isActive: boolean("is_active").notNull().default(true),
    /** Customer-level invoicing/backup override (cascades over project type). */
    invoicingPreference: jsonb("invoicing_preference").$type<InvoicingPreference>(),
    /** Invoicing rules agreed with this customer, layered over the project type. */
    invoicingProfile: jsonb("invoicing_profile"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("parties_org_name").on(t.orgId, t.displayName),
    uniqueIndex("parties_org_shortcode").on(t.orgId, t.shortCode),
    uniqueIndex("parties_org_source_identity")
      .on(
        t.orgId,
        sql`(${t.custom}->'source'->>'system')`,
        sql`(${t.custom}->'source'->>'externalId')`,
      )
      .where(sql`
        ${t.custom}->'source'->>'system' is not null
        and ${t.custom}->'source'->>'externalId' is not null
      `),
  ],
);

export const customerRoles = pgTable("customer_roles", {
  id: id(),
  orgId: orgRef(),
  partyId: uuid("party_id").notNull().unique(),
  arAccountId: uuid("ar_account_id"), // default receivable account
  paymentTermsId: uuid("payment_terms_id"),
  creditLimit: money("credit_limit"),
  currency: currencyCode("currency"),
  salesRepId: uuid("sales_rep_id"), // → parties (employee)
  taxCodeId: uuid("tax_code_id"),
  isOnHold: boolean("is_on_hold").notNull().default(false),
  holdReason: text("hold_reason"),
  heldAt: timestamp("held_at", { withTimezone: true }),
  heldBy: uuid("held_by"),
  isActive: boolean("is_active").notNull().default(true),
  custom: jsonb("custom").notNull().default({}),
  ...auditColumns,
});

export const vendorRoles = pgTable("vendor_roles", {
  id: id(),
  orgId: orgRef(),
  partyId: uuid("party_id").notNull().unique(),
  apAccountId: uuid("ap_account_id"),
  paymentTermsId: uuid("payment_terms_id"),
  defaultExpenseAccountId: uuid("default_expense_account_id"),
  paymentMethod: text("payment_method", { enum: ["eft", "cheque", "card", "cash", "other"] }),
  eftNotificationEmail: text("eft_notification_email"),
  currency: currencyCode("currency"),
  taxCodeId: uuid("tax_code_id"),
  /**
   * Reportable on a year-end information return (1099/T4A). THE switch for
   * "do we file for this vendor"; `informationReturnForm` only decides which
   * form, and the resolver requires both (see engine/src/information-returns.ts).
   */
  is1099OrT4a: boolean("is_t4a").notNull().default(false),
  /**
   * Subcontractor-compliance classification (→ compliance_classes). NULL means
   * this vendor is not subject to compliance tracking at all — there is no
   * separate "tracked" flag to fall out of sync with.
   */
  complianceClassId: uuid("compliance_class_id"),
  /** Which information return to file; null = inherit the compliance class default. */
  informationReturnForm: text("information_return_form", {
    enum: ["none", "1099-NEC", "1099-MISC", "T4A"],
  }),
  /** Default box for this vendor's spend; null = the form's default box. */
  informationReturnBox: text("information_return_box"),
  /** W-9 / TD1 federal tax classification — drives corporation exclusions. */
  taxClassification: text("tax_classification", {
    enum: [
      "individual",
      "sole_proprietor",
      "partnership",
      "c_corp",
      "s_corp",
      "llc",
      "trust_estate",
      "government",
      "nonprofit",
      "other",
    ],
  }),
  /** Taxpayer identification number, sealed at rest (engine/src/secrets.ts). */
  tinEncrypted: text("tin_encrypted"),
  /** Last four digits, plaintext, for display and matching. Never the full TIN. */
  tinLast4: text("tin_last4"),
  tinType: text("tin_type", { enum: ["ssn", "ein", "itin", "atin", "sin", "bn", "unknown"] }),
  /** Under backup withholding (missing/incorrect TIN, IRS B-notice). */
  backupWithholding: boolean("backup_withholding").notNull().default(false),
  isOnHold: boolean("is_on_hold").notNull().default(false),
  holdReason: text("hold_reason"),
  heldAt: timestamp("held_at", { withTimezone: true }),
  heldBy: uuid("held_by"),
  isActive: boolean("is_active").notNull().default(true),
  custom: jsonb("custom").notNull().default({}),
  ...auditColumns,
});

/**
 * Employee role carries what payroll/job-costing needs. Trade + worker-comp
 * classification were bolt-on lists in source platform (WSIB groups, Employee Trade)
 * but drive real money (burden rates, comp premiums) — promoted here.
 */
export const employeeRoles = pgTable("employee_roles", {
  id: id(),
  orgId: orgRef(),
  partyId: uuid("party_id").notNull().unique(),
  employeeNumber: text("employee_number"),
  /** Free-form operational title used for workforce planning and wage scope. */
  jobTitle: text("job_title"),
  departmentId: uuid("department_id"),
  supervisorId: uuid("supervisor_id"), // → parties
  tradeId: uuid("trade_id"),
  workerCompGroupId: uuid("worker_comp_group_id"),
  hiredOn: date("hired_on"),
  terminatedOn: date("terminated_on"),
  /** PII, used by payroll only: ROE demographics and the configurable
   *  stub-password policy ("surname + date of birth"). Deliberately outside
   *  the governed query views. */
  birthDate: date("birth_date"),
  hasBenefits: boolean("has_benefits").notNull().default(false),
  vacationDaysPerYear: integer("vacation_days_per_year"),
  billableUtilizationTarget: integer("billable_utilization_target"), // percent
  expenseAccountId: uuid("expense_account_id"), // reimbursable clearing
  externalPayrollId: text("external_payroll_id"),
  isActive: boolean("is_active").notNull().default(true),
  custom: jsonb("custom").notNull().default({}),
  ...auditColumns,
});

export const trades = pgTable("trades", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(), // Electrician, Millwright, Welder…
  isActive: boolean("is_active").notNull().default(true),
});

export const workerCompGroups = pgTable("worker_comp_groups", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(), // "WSIB 704"
  name: text("name").notNull(), // "Electrical"
  ratePercent: money("rate_percent"),
  /** Annual assessable-earnings maximum per worker (class/province data);
   *  null = no cap. Payroll's WCB accrual stops here. */
  maxAssessable: money("max_assessable"),
  isActive: boolean("is_active").notNull().default(true),
});

export const addresses = pgTable(
  "addresses",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    label: text("label"), // "Head office", "Site 12"
    line1: text("line1"),
    line2: text("line2"),
    city: text("city"),
    region: text("region"), // province/state
    postalCode: text("postal_code"),
    country: text("country"),
    isDefaultBilling: boolean("is_default_billing").notNull().default(false),
    isDefaultShipping: boolean("is_default_shipping").notNull().default(false),
    custom: jsonb("custom").notNull().default({}), // source nsId bridge for sync
    ...auditColumns,
  },
  (t) => [index("addresses_party").on(t.partyId)],
);

/**
 * Contacts — people at a customer/vendor company (source platform's separate `contact`
 * entity). Linked to the company party; carries their own role, title, and
 * contact info. A company party can have many contacts; one may be primary.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id"), // the company party this contact belongs to
    firstName: text("first_name"),
    lastName: text("last_name"),
    name: text("name").notNull(), // full/display name
    title: text("title"), // job title
    role: text("role"), // contact role (Primary, Billing, Purchasing…)
    email: text("email"),
    phone: text("phone"),
    mobilePhone: text("mobile_phone"),
    fax: text("fax"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [index("contacts_party").on(t.partyId)],
);

/**
 * Normalized bank accounts (source platform: a 52-field custom record). Changes are
 * fraud-sensitive: `approvedAt/By` gate use in payment runs, mirroring the
 * bank-details approval workflow found in the extraction.
 */
export const partyBankAccounts = pgTable(
  "party_bank_accounts",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    bankName: text("bank_name"),
    country: text("country"),
    currency: currencyCode("currency"),
    // Canadian EFT: institution + transit + account. Kept generic:
    routing: jsonb("routing").$type<Record<string, string>>().notNull().default({}),
    accountNumberEncrypted: text("account_number_encrypted"), // app-layer envelope encryption
    accountLastFour: text("account_last_four"),
    approvedAt: date("approved_at"),
    approvedBy: uuid("approved_by"),
    /**
     * Bank-detail change approval (the source platform "Vendor Bank Details Approval"
     * workflow, replicated as a flow): new/edited details sit 'pending' —
     * inactive and unusable by payment runs — until the gate approves.
     * Existing rows default 'approved' (they were in use pre-flows).
     */
    approvalStatus: text("approval_status", { enum: ["pending", "approved", "rejected"] })
      .notNull()
      .default("approved"),
    /** Actual maker for the current material revision (not original creator). */
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: uuid("retired_by"),
    retirementReason: text("retirement_reason"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("bank_accounts_party").on(t.partyId)],
);

export const paymentTerms = pgTable("payment_terms", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(), // "Net 30"
  netDays: integer("net_days").notNull().default(30),
  discountDays: integer("discount_days"),
  discountPercent: money("discount_percent"),
  isActive: boolean("is_active").notNull().default(true),
  custom: jsonb("custom").notNull().default({}), // source nsId bridge for sync
});
