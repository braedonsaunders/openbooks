import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * One party model. A party is a real-world person or company; ROLES make it
 * a customer, vendor, and/or employee. NetSuite's separate entity tables
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
    shortCode: text("short_code"), // Rassaun's "Shortform" custentity, promoted
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    taxIds: jsonb("tax_ids").$type<Record<string, string>>().default({}),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("parties_org_name").on(t.orgId, t.displayName),
    uniqueIndex("parties_org_shortcode").on(t.orgId, t.shortCode),
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
  is1099OrT4a: boolean("is_t4a").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  custom: jsonb("custom").notNull().default({}),
  ...auditColumns,
});

/**
 * Employee role carries what payroll/job-costing needs. Trade + worker-comp
 * classification were bolt-on lists in NetSuite (WSIB groups, Employee Trade)
 * but drive real money (burden rates, comp premiums) — promoted here.
 */
export const employeeRoles = pgTable("employee_roles", {
  id: id(),
  orgId: orgRef(),
  partyId: uuid("party_id").notNull().unique(),
  employeeNumber: text("employee_number"),
  departmentId: uuid("department_id"),
  supervisorId: uuid("supervisor_id"), // → parties
  tradeId: uuid("trade_id"),
  workerCompGroupId: uuid("worker_comp_group_id"),
  hiredOn: date("hired_on"),
  terminatedOn: date("terminated_on"),
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
    ...auditColumns,
  },
  (t) => [index("addresses_party").on(t.partyId)],
);

/**
 * Normalized bank accounts (NetSuite: a 52-field custom record). Changes are
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
});
