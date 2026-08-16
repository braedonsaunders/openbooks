import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

// Foreign keys are maintained in the migration (DEFERRABLE, per house rule).
