import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Payroll filing (remittance) accounts.
 *
 * One employer is rarely one filing identity. A Canadian business number
 * carries several payroll program accounts (…RP0001, …RP0002) — divisions that
 * remit, file T4s, and receive PD7A statements separately. The US equivalent is
 * several EINs plus a per-state unemployment (SUI) account per state the
 * employer is registered in.
 *
 * Doctrine:
 * - The account is the FILING identity, never a second wage/statutory rule
 *   source: the engines still compute from the employee's country pack.
 * - Employees are assigned one account (employee_payroll_profiles.filing_account_id);
 *   remittance summaries, PD7A worksheets, and T4/W-2 returns group by it.
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
    country: text("country", { enum: ["CA", "US"] }).notNull(),
    /**
     * What kind of filing identity this is: a CRA payroll program account
     * (RP), a US federal employer identification number, or a state
     * unemployment-insurance account (one per state, under an EIN).
     */
    programType: text("program_type", {
      enum: ["ca_rp", "us_ein", "us_state_sui"],
    }).notNull(),
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
    /** State postal code — required for, and only for, us_state_sui accounts. */
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
    check(
      "payroll_filing_accounts_program_country",
      sql`(${t.country} = 'CA' and ${t.programType} = 'ca_rp')
          or (${t.country} = 'US' and ${t.programType} in ('us_ein', 'us_state_sui'))`,
    ),
    check(
      "payroll_filing_accounts_state",
      sql`(${t.programType} = 'us_state_sui') = (${t.stateCode} is not null)`,
    ),
  ],
);

// Foreign keys are maintained in the migration (DEFERRABLE, per house rule).
